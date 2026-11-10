import type { ChatMsg } from '@/api/client';
import { orientationOfSize, type Orientation } from '@/backends/size';
import { cleanHistoryText, type PreparedTargetText, type TargetSegment } from '@/autoTag/clean';
import {
  buildCharCardSystem,
  buildPersonaSystem,
  fetchCharCard,
  fetchUserPersona,
} from '@/autoTag/context';
import type { ImageInsertion, ImagePlan } from '@/autoTag/protocol';
import { recentFloors, roleLabel } from '@/autoTag/prompt';
import type { STContext } from '@/st/context';
import {
  settings,
  type WorldbookChainBook,
  type WorldbookChainEntry,
  type WorldbookChainMessageRole,
  type WorldbookChainTriggerMode,
} from '@/state/settings';

/**
 * 世界书链:把导入的世界书按原 role/触发方式组装成请求,替代内置思维链与破限词。
 *
 * 与 st-chatu8 的「导入 LLM / 测试上下文」同源,但补了两处它没做的事:
 * - 触发词用目标楼 + 携带上下文一起匹配(它的 image_gen 路径不传 triggerText,
 *   126 条 trigger 条目会被整批丢掉);
 * - 输出是 `<images><image>…regex:…image###…###</image></images>`,解析时把 regex 锚点
 *   映射回本插件的 P# 位置,再复用 runner 的写回/重定位管线。
 *
 * 本模块不读酒馆世界书:导入的书就是本链的世界书,再叠一份 ST 世界书只会重复注入。
 */

const CHAIN_ADAPTER = `【世界书链适配说明】
本次生图按导入的世界书规则执行。插件没有世界书里的 \${...}$ 角色/服装调用系统:
- 不要输出 \${...}$ 形式的调用;角色外貌与服装直接写成 image### 里的 Tag。
- 角色固定外貌以下方【角色固定外貌库】为准,逐字照抄对应字段;库里没有的角色按世界书规则处理。
- 输出只包含世界书要求的 <images>…</images>;每张图一个 image### 块,不要续写故事、不要重复原文。`;

const CHAIN_USER_DEMAND = '请把下方剧情正文转译为世界书规定的生图提示词，按世界书要求输出多张图片。';

const ROLL_PATTERN = /\{\{roll\s+(?:1d)?(\d+)\}\}/gi;
const ROLL_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const ROLL_LENGTH = 8;
const SIZE_PATTERN = /(\d{2,4})\s*[x×X*]\s*(\d{2,4})/;

let bookSeq = 0;
let entrySeq = 0;

function nextBookId(): string {
  bookSeq += 1;
  return `wb_${Date.now()}_${bookSeq}`;
}

function nextEntryId(): string {
  entrySeq += 1;
  return `wb_entry_${Date.now()}_${entrySeq}`;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string').join(', ');
  }
  return '';
}

function isEntry(entry: WorldbookChainEntry | null): entry is WorldbookChainEntry {
  return entry !== null;
}

/* ============ 导入:兼容 st-chatu8 与酒馆标准世界书 ============ */

function toChainEntry(raw: unknown, index: number): WorldbookChainEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const content = textOf(value.content);
  if (!content.trim()) return null;
  const triggerWords = textOf(value.triggerWords ?? value.keywords ?? value.key);
  const andTriggerWords = textOf(value.andTriggerWords ?? value.keysecondary);
  const mode = typeof value.triggerMode === 'string' ? value.triggerMode : '';
  const enabled =
    typeof value.enabled === 'boolean'
      ? value.enabled
      : typeof value.disable === 'boolean'
        ? !value.disable
        : true;
  const roleRaw = typeof value.role === 'string' ? value.role : '';
  const role: WorldbookChainMessageRole =
    roleRaw === 'user' || roleRaw === 'assistant' ? roleRaw : 'system';
  const triggerMode: WorldbookChainTriggerMode =
    mode === 'always' || mode === 'blue' || value.constant === true
      ? 'always'
      : mode === 'trigger' || mode === 'green' || triggerWords.trim()
        ? 'trigger'
        : 'always';
  return {
    id: typeof value.id === 'string' && value.id ? value.id : `wb_entry_${index}`,
    name: textOf(value.name ?? value.comment) || `条目 ${index + 1}`,
    role,
    content,
    enabled,
    triggerMode,
    triggerWords,
    andTriggerWords,
  };
}

function historyEntries(raw: unknown): WorldbookChainEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: WorldbookChainEntry[] = [];
  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const value = item as Record<string, unknown>;
    const user = textOf(value.user);
    const assistant = textOf(value.assistant);
    if (user.trim()) {
      entries.push({
        id: nextEntryId(),
        name: `历史 ${index + 1} user`,
        role: 'user',
        content: user,
        enabled: true,
        triggerMode: 'always',
        triggerWords: '',
        andTriggerWords: '',
      });
    }
    if (assistant.trim()) {
      entries.push({
        id: nextEntryId(),
        name: `历史 ${index + 1} assistant`,
        role: 'assistant',
        content: assistant,
        enabled: true,
        triggerMode: 'always',
        triggerWords: '',
        andTriggerWords: '',
      });
    }
  });
  return entries;
}

function bookFromEntries(name: string, entries: WorldbookChainEntry[]): WorldbookChainBook | null {
  if (!entries.length) return null;
  return { id: nextBookId(), name, importedAt: Date.now(), entries };
}

function bookFromContainer(name: string, value: Record<string, unknown>): WorldbookChainBook | null {
  if (Array.isArray(value.entries)) {
    return bookFromEntries(name, value.entries.map(toChainEntry).filter(isEntry));
  }
  if (value.entries && typeof value.entries === 'object') {
    const entries = Object.values(value.entries as Record<string, unknown>)
      .map(toChainEntry)
      .filter(isEntry);
    return bookFromEntries(name, entries);
  }
  if (Array.isArray(value.history)) {
    return bookFromEntries(name, historyEntries(value.history));
  }
  return null;
}

/**
 * 解析导入文件。支持:
 * - st-chatu8 导出数组 `[{name, worldBooks:[...]}]` / `{name, worldBooks:[...]}`;
 * - 测试上下文 `{bookName: {entries|history}}`(用户这份 anima 世界书就是这种);
 * - 酒馆标准世界书 `{entries: {"0": {key, content, comment, disable, constant}}}`。
 * 一个文件里有多本书就返回多本;读不出任何条目返回空数组,由调用方提示。
 */
export function parseWorldbookImport(data: unknown, fallbackName: string): WorldbookChainBook[] {
  if (Array.isArray(data)) {
    const outer = data.filter(
      item => item && typeof item === 'object' && Array.isArray((item as Record<string, unknown>).worldBooks),
    );
    if (outer.length) {
      const books: WorldbookChainBook[] = [];
      outer.forEach((item, index) => {
        const value = item as Record<string, unknown>;
        const name = textOf(value.name) || `${fallbackName}_${index + 1}`;
        const entries = (value.worldBooks as unknown[]).map(toChainEntry).filter(isEntry);
        const book = bookFromEntries(name, entries);
        if (book) books.push(book);
      });
      return books;
    }
    const book = bookFromEntries(fallbackName, data.map(toChainEntry).filter(isEntry));
    return book ? [book] : [];
  }
  if (!data || typeof data !== 'object') return [];
  const value = data as Record<string, unknown>;
  if (Array.isArray(value.worldBooks)) {
    const entries = value.worldBooks.map(toChainEntry).filter(isEntry);
    const book = bookFromEntries(textOf(value.name) || fallbackName, entries);
    return book ? [book] : [];
  }
  if (value.entries || value.history) {
    const book = bookFromContainer(textOf(value.name) || fallbackName, value);
    return book ? [book] : [];
  }
  const books: WorldbookChainBook[] = [];
  for (const [name, container] of Object.entries(value)) {
    if (!container || typeof container !== 'object') continue;
    const book = bookFromContainer(name, container as Record<string, unknown>);
    if (book) books.push(book);
  }
  return books;
}

/* ============ 组装请求 ============ */

function stripPresetComments(text: string): string {
  return text
    .replace(/\{\{\/\/[\s\S]*?\}\}/g, '')
    .replace(/^[ \t]*\/\/\*.*?(?:\*+\/+|\*\/)?[ \t]*(?:\r?\n|$)/gm, '')
    .replace(/\/\/\*[\s\S]*?(?:\*+\/+|\*\/)/g, '')
    .replace(/[ \t]+\/\/\*.*?(?:\*+\/+|\*\/)?(?=$|\r?\n)/g, '')
    .replace(/(\r?\n){3,}/g, '$1$1')
    .trim();
}

function splitTriggerWords(value: string): string[] {
  return value
    .split(/[,，、\n]/)
    .map(word => word.trim())
    .filter(Boolean);
}

function hitTriggerWords(value: string, text: string): boolean {
  if (!value.trim() || !text) return false;
  const haystack = text.toLowerCase();
  return splitTriggerWords(value).some(word => haystack.includes(word.toLowerCase()));
}

function entryActive(entry: WorldbookChainEntry, triggerText: string): boolean {
  if (!entry.enabled) return false;
  if (entry.triggerMode === 'always') return true;
  if (!hitTriggerWords(entry.triggerWords, triggerText)) return false;
  return !entry.andTriggerWords.trim() || hitTriggerWords(entry.andTriggerWords, triggerText);
}

function applyPlaceholders(text: string, values: Record<string, string>): string {
  let result = text;
  for (const [placeholder, value] of Object.entries(values)) {
    result = result.split(placeholder).join(value);
  }
  return result;
}

/** `{@setvar::名::值@}` / `{@getvar::名@}` 三轮回填;全局/世界变量本链不读写,一律清空。 */
function applyVariables(text: string, variables: Map<string, string>): string {
  let result = text
    .replace(/\{@setvar::([^:@]+)::([\s\S]*?)@\}/g, (_match, name: string, value: string) => {
      variables.set(name.trim(), value);
      return '';
    })
    .replace(/\{\{setvar::([^:}]+)::([\s\S]*?)\}\}/g, (_match, name: string, value: string) => {
      variables.set(name.trim(), value);
      return '';
    })
    .replace(/\{@setglobalvar::[^@]+@\}/g, '');
  for (let round = 0; round < 3; round += 1) {
    const before = result;
    result = result
      .replace(/\{@getvar::([^@]+)@\}/g, (_match, name: string) => variables.get(name.trim()) ?? '')
      .replace(/\{\{getvar::([^}]+)\}\}/g, (_match, name: string) => variables.get(name.trim()) ?? '')
      .replace(/\{@getglobalvar::[^@]+@\}/g, '')
      .replace(/\{@getworldvar::[^@]+@\}/g, '');
    if (result === before) break;
  }
  return result;
}

function randomRollString(): string {
  let out = '';
  for (let index = 0; index < ROLL_LENGTH; index += 1) {
    out += ROLL_CHARSET[Math.floor(Math.random() * ROLL_CHARSET.length)];
  }
  return out;
}

function applyRolls(text: string): string {
  return text.replace(ROLL_PATTERN, () => randomRollString());
}

function processEntryContent(
  entry: WorldbookChainEntry,
  variables: Map<string, string>,
  placeholders: Record<string, string>,
): string {
  const stripped = stripPresetComments(entry.content);
  if (!stripped.trim()) return '';
  return applyRolls(applyVariables(applyPlaceholders(stripped, placeholders), variables)).trim();
}

function tagLimitInstruction(limit: number): string {
  return `【单张提示词长度限制】
每个 image### 的正文必须在 1–${limit} 个字符以内（含 Tag、NL、逗号、空格）。优先保留主体、构图、角色外貌、服装状态、动作表情、场景光线；次要装饰、重复 Tag、解释性文字先删。上游生图模型只接收约 2000 token，超过上限会被拒绝。`;
}

export interface WorldbookChainBuildOptions {
  contextMessages: number;
  enforceTagLimit: boolean;
  tagLimitChars: number;
}

/** 携带的上下文:每楼带角色头,口径与旧链一致(recentFloors + cleanHistoryText)。 */
function buildPreviousText(
  context: STContext,
  targetFloor: number,
  contextMessages: number,
  stripTags: string[],
): string {
  return recentFloors(context, targetFloor, contextMessages)
    .filter(floor => floor !== targetFloor)
    .map(
      floor =>
        `--- 上下文｜${roleLabel(context, floor)} ---\n${cleanHistoryText(
          context.chat[floor].mes,
          stripTags,
        )}`,
    )
    .join('\n\n');
}

/**
 * 组装世界书链请求:适配说明(含长度限制)→ 角色卡 → 人设 → 按书内顺序过滤后的条目。
 * 触发文本 = 目标楼清洗正文 + 携带的上下文,避免 trigger 条目因只看目标楼而漏触发。
 */
export function buildWorldbookChainMessages(
  context: STContext,
  targetFloor: number,
  book: WorldbookChainBook,
  options: WorldbookChainBuildOptions,
  preparedTarget: PreparedTargetText,
  libraryText?: string | null,
): ChatMsg[] {
  const stripTags = settings.excludes.customStripTags;
  const targetText = preparedTarget.segments.map(segment => segment.text).join('\n\n');
  const previousText = buildPreviousText(context, targetFloor, options.contextMessages, stripTags);
  const triggerText = `${targetText}\n${previousText}`;
  const placeholders: Record<string, string> = {
    '{{正文}}': targetText,
    '{{上下文}}': previousText,
    '{{世界书触发}}': '',
    '{{用户需求}}': CHAIN_USER_DEMAND,
    '{{角色启用列表}}': (libraryText ?? '').trim(),
    '{{通用角色启用列表}}': '',
    '{{通用服装启用列表}}': '',
  };
  const variables = new Map<string, string>();
  const adapter = options.enforceTagLimit
    ? `${CHAIN_ADAPTER}\n\n${tagLimitInstruction(options.tagLimitChars)}`
    : CHAIN_ADAPTER;
  const messages: ChatMsg[] = [{ role: 'system', content: adapter }];
  const charCard = fetchCharCard(context);
  if (charCard) messages.push({ role: 'system', content: buildCharCardSystem(charCard) });
  const persona = fetchUserPersona(context);
  if (persona) messages.push({ role: 'system', content: buildPersonaSystem(persona) });
  for (const entry of book.entries) {
    if (!entryActive(entry, triggerText)) continue;
    const content = processEntryContent(entry, variables, placeholders);
    if (content) messages.push({ role: entry.role, content });
  }
  return messages;
}

/* ============ 解析输出 ============ */

export interface WorldbookChainParseOptions {
  maxImages: number;
  enforceTagLimit: boolean;
  tagLimitChars: number;
}

function extractImageBlocks(raw: string): string[] {
  const wrapper = raw.match(/<images\b[^>]*>([\s\S]*?)<\/images>/i);
  const source = wrapper ? wrapper[1] : raw;
  const wrapped = [...source.matchAll(/<image\b[^>]*>([\s\S]*?)<\/image>/gi)].map(match => match[1]);
  if (wrapped.length) return wrapped;
  return [...source.matchAll(/image###[\s\S]*?###/gi)].map(match => match[0]);
}

function extractAnchor(block: string): string {
  // 锚点可能紧跟 </font> 在同一行,故不要求行首;遇到 <Tag_think> 等标签即截止。
  const match = block.match(/\bregex\s*[:：]\s*([^\n\r<]+)/i);
  if (!match) return '';
  const anchor = match[1]
    .trim()
    .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
  if (!anchor || /^x+$/i.test(anchor) || /^(original text|原文)$/i.test(anchor)) return '';
  return anchor;
}

/** 去空白与标点后比较,容忍模型少一个逗号/引号;保留所有文字与数字。 */
function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function positionForAnchor(
  anchor: string,
  segments: TargetSegment[],
  used: ReadonlySet<string>,
  imageIndex: number,
): string {
  const needle = normalizeForMatch(anchor);
  if (needle.length >= 2) {
    const unused = segments.find(
      segment => !used.has(segment.id) && normalizeForMatch(segment.text).includes(needle),
    );
    if (unused) return unused.id;
    const any = segments.find(segment => normalizeForMatch(segment.text).includes(needle));
    if (any) return any.id;
  }
  return segments[Math.min(imageIndex, segments.length - 1)]?.id ?? '';
}

function extractSize(block: string): Orientation {
  const think = block.match(/<Tag_think\b[^>]*>([\s\S]*?)<\/Tag_think>/i)?.[1] ?? '';
  const match = think.match(SIZE_PATTERN) ?? block.match(SIZE_PATTERN);
  if (!match) return 'portrait';
  return orientationOfSize({ width: Number(match[1]), height: Number(match[2]) });
}

function cleanTagBody(body: string, options: WorldbookChainParseOptions): string {
  const tag = body
    .replace(/\$\{[\s\S]*?\}\$/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/<\/?images?\b[^>]*>/gi, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[,，]\s*[,，]+/g, ',')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[,，;；\s]+|[,，;；\s]+$/g, '');
  if (!tag) return '';
  if (options.enforceTagLimit) {
    const length = Array.from(tag).length;
    if (length > options.tagLimitChars) {
      console.warn(
        `[柏宝绘] 世界书链单张提示词 ${length} 字符，超过设置上限 ${options.tagLimitChars}；上游可能拒绝`,
      );
    }
  }
  return tag;
}

/**
 * 解析世界书输出:`<images><image>…regex:锚点…image###正文###</image></images>`。
 * regex 锚点映射回目标正文的 P# 位置;锚点缺失/匹配不上时按图片顺序回落到对应段落。
 * 一张都解析不出时抛错,交给 runner 的重试/备用渠道逻辑。
 */
export function parseWorldbookChainPlan(
  raw: string,
  segments: TargetSegment[],
  options: WorldbookChainParseOptions,
): ImagePlan {
  if (!segments.length) throw new Error('目标正文没有可插入位置');
  const cleaned = raw.replace(/<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi, '');
  const blocks = extractImageBlocks(cleaned);
  if (!blocks.length) throw new Error('世界书链没有返回 image### 块');
  const sourceLines = new Map(segments.map(segment => [segment.id, segment.sourceLine]));
  const used = new Set<string>();
  const images: ImageInsertion[] = [];
  const limit = Math.max(1, Math.floor(Number(options.maxImages) || 1));
  for (let index = 0; index < blocks.length && images.length < limit; index += 1) {
    const block = blocks[index];
    const body = block.match(/image###([\s\S]*?)###/i)?.[1] ?? '';
    const tag = cleanTagBody(body, options);
    if (!tag) continue;
    const position = positionForAnchor(extractAnchor(block), segments, used, index);
    const sourceLine = sourceLines.get(position);
    if (sourceLine === undefined) continue;
    images.push({
      position,
      sourceLine,
      tag,
      nl: '',
      negative: '',
      characters: [],
      size: extractSize(block),
    });
    used.add(position);
  }
  if (!images.length) throw new Error('世界书链返回的 image### 块全部为空');
  return { images, changes: [] };
}

/** 当前激活的书;悬空 id 回落第一本,空书库返回 null(调用方按未启用处理)。 */
export function activeWorldbook(settingsValue: {
  enabled: boolean;
  activeBookId: string;
  books: WorldbookChainBook[];
}): WorldbookChainBook | null {
  if (!settingsValue.enabled || !settingsValue.books.length) return null;
  return (
    settingsValue.books.find(book => book.id === settingsValue.activeBookId) ??
    settingsValue.books[0] ??
    null
  );
}
