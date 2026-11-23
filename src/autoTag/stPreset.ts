import {
  getContext,
  type STChatCompletionSettings,
  type STPresetOrder,
  type STPresetPrompt,
} from '@/st/context';
import type { AutoTagSettings, ImportedPreset } from '@/state/settings';

/**
 * 破限词的「跟随酒馆预设」来源(只读,绝不写回酒馆)。
 *
 * 酒馆把当前聊天补全预设实时放在 `getContext().chatCompletionSettings`(即 oai_settings):
 * - `prompts[]`:预设里的全部提示词条目(含 main / nsfw / jailbreak / 自定义条目);
 * - `prompt_order[]`:每个角色/全局的启用状态与顺序,聊天补全的全局顺序用 dummy id 100001;
 * - `preset_settings_openai`:当前预设名。
 *
 * 本模块只负责「读当前预设 → 按用户勾选拼文本」,不做任何持久化。
 */

/** 聊天补全的全局提示词顺序表 id(ST PromptManager 的 promptOrder.dummyId)。 */
const GLOBAL_ORDER_ID = 100001;
/** 默认/角色顺序表 id,作为旧预设的兜底。 */
const DEFAULT_ORDER_ID = 100000;

/** 一条可在设置页勾选的预设提示词。 */
export interface StPresetEntry {
  identifier: string;
  name: string;
  content: string;
  /** 酒馆顺序表里是否启用;仅作提示,勾选后仍会使用其文本。 */
  enabled: boolean;
  /** 是否在酒馆的提示词顺序表里;不在的条目酒馆不会主动发送,但文本仍可复用。 */
  inOrder: boolean;
  /** 占位项(聊天历史/角色卡字段等),通常没有固定文本,不能作为破限词。 */
  marker: boolean;
}

export interface StPresetSnapshot {
  presetName: string;
  entries: StPresetEntry[];
}

const warnedMessages = new Set<string>();

/** 同一类回退只吵一次:自动 tag 每楼都跑,不节流会把控制台刷爆。 */
function warnOnce(message: string): void {
  if (warnedMessages.has(message)) return;
  warnedMessages.add(message);
  console.warn(`[柏宝绘] ${message}`);
}

/** 取当前生效的顺序表:全局 100001 → 默认 100000 → 条目最多的非空顺序表。 */
function pickOrder(orders: STPresetOrder[] | undefined): STPresetOrder['order'] {
  if (!Array.isArray(orders)) return [];
  const byId = (id: number) => orders.find(order => String(order?.character_id) === String(id));
  for (const candidate of [byId(GLOBAL_ORDER_ID), byId(DEFAULT_ORDER_ID)]) {
    if (Array.isArray(candidate?.order) && candidate.order.length) return candidate.order;
  }
  let longest: STPresetOrder['order'] = [];
  for (const order of orders) {
    if (Array.isArray(order?.order) && order.order.length > (longest?.length ?? 0)) {
      longest = order.order;
    }
  }
  return longest;
}

/** 把预设里的单条提示词转成列表项;保留 marker/空内容,由 UI 标明不可选。 */
function toPresetEntry(
  prompt: STPresetPrompt,
  identifier: string,
  enabled: boolean,
  inOrder: boolean,
): StPresetEntry {
  return {
    identifier,
    name: typeof prompt.name === 'string' && prompt.name.trim() ? prompt.name.trim() : identifier,
    content: typeof prompt.content === 'string' ? prompt.content.trim() : '',
    enabled,
    inOrder,
    marker: prompt.marker === true,
  };
}

/**
 * 从一份聊天补全设置里抽出全部提示词条目(纯函数)。
 * 先按顺序表排列,再补上顺序表里没有的条目——不静默丢条目,否则用户会以为预设只剩几条。
 * 占位项、空内容、非系统角色条目都保留,是否可选由调用方按 content 判断。
 */
export function readPresetEntries(settings: STChatCompletionSettings | undefined): StPresetEntry[] {
  if (!settings) return [];
  const byId = new Map<string, STPresetPrompt>();
  for (const prompt of Array.isArray(settings.prompts) ? settings.prompts : []) {
    const identifier = typeof prompt?.identifier === 'string' ? prompt.identifier : '';
    if (identifier && !byId.has(identifier)) byId.set(identifier, prompt);
  }

  const entries: StPresetEntry[] = [];
  const seen = new Set<string>();
  for (const order of pickOrder(settings.prompt_order) ?? []) {
    const identifier = typeof order?.identifier === 'string' ? order.identifier : '';
    const prompt = identifier ? byId.get(identifier) : undefined;
    if (!prompt || seen.has(identifier)) continue;
    seen.add(identifier);
    entries.push(toPresetEntry(prompt, identifier, order.enabled === true, true));
  }
  for (const [identifier, prompt] of byId) {
    if (!seen.has(identifier)) entries.push(toPresetEntry(prompt, identifier, false, false));
  }
  return entries;
}

/** 读取酒馆当前聊天补全预设;读不到返回 null(旧版酒馆 / 非浏览器环境)。 */
export function readCurrentChatPreset(): StPresetSnapshot | null {
  const settings = getContext()?.chatCompletionSettings;
  if (!settings) return null;
  return {
    presetName:
      typeof settings.preset_settings_openai === 'string' ? settings.preset_settings_openai : '',
    entries: readPresetEntries(settings),
  };
}

/** 展开 ST 宏({{char}} 等);宿主没提供或展开失败时保留原文。 */
function expandMacros(text: string): string {
  const substitute = getContext()?.substituteParams;
  if (typeof substitute !== 'function') return text;
  try {
    const expanded = substitute(text);
    return typeof expanded === 'string' ? expanded : text;
  } catch {
    return text;
  }
}

/**
 * 按勾选的 identifier 拼文本:只拼「勾选 ∩ 存在 ∩ 非空」的条目,顺序跟条目顺序。
 * 启用状态只作提示——用户显式勾选就尊重选择。
 * 实时预设与导入快照共用这一份,保证两条来源的拼接口径逐字一致。
 */
function joinEntries(entries: readonly StPresetEntry[], identifiers: readonly string[]): string {
  if (!identifiers.length) return '';
  const wanted = new Set(identifiers);
  const texts: string[] = [];
  for (const entry of entries) {
    if (!wanted.has(entry.identifier) || !entry.content) continue;
    const text = expandMacros(entry.content).trim();
    if (text) texts.push(text);
  }
  return texts.join('\n\n');
}

/**
 * 按勾选的 identifier 取酒馆当前预设文本;读不到/全空返回空串,由调用方回退。
 */
export function resolvePresetJailbreak(identifiers: readonly string[]): string {
  if (!identifiers.length) return '';
  const settings = getContext()?.chatCompletionSettings;
  if (!settings) return '';
  return joinEntries(readPresetEntries(settings), identifiers);
}

/** 预设文件解析结果:显示名 + 条目(结构与实时预设的条目同构)。 */
export interface ParsedPresetFile {
  name: string;
  entries: StPresetEntry[];
}

const PRESET_FILE_HINT =
  '这不是酒馆聊天补全预设文件：缺 prompts / prompt_order。请用「聊天补全」预设的导出文件。';

/**
 * 解析一份酒馆聊天补全预设 JSON(导入用)。
 *
 * 吃两种形态:标准预设(`prompts` + `prompt_order`)与只有 `prompts` 的老导出。
 * 世界书 JSON 也是 `{ entries: {...} }`,这里靠 prompts/prompt_order 明确拒收,
 * 免得用户导错文件后得到一份「空预设」还不知道为什么。
 * 只取文本与顺序,不保留 temperature 等采样参数——破限词只用得上文字。
 */
export function parsePresetFile(raw: unknown, fileName = ''): ParsedPresetFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(PRESET_FILE_HINT);
  const value = raw as STChatCompletionSettings;
  if (!Array.isArray(value.prompts) && !Array.isArray(value.prompt_order)) {
    throw new Error(PRESET_FILE_HINT);
  }
  const entries = readPresetEntries(value);
  if (!entries.length) throw new Error('文件里没有可用的提示词条目。');
  const selfName =
    typeof value.preset_settings_openai === 'string' ? value.preset_settings_openai.trim() : '';
  const fileBase = fileName.replace(/\.json$/i, '').trim();
  return { name: selfName || fileBase || '导入的预设', entries };
}

/** 从导入的预设快照里取文本;preset 不存在时 found=false,由调用方决定怎么回退。 */
export function resolveImportedJailbreak(
  presets: readonly ImportedPreset[] | undefined,
  presetId: string,
  identifiers: readonly string[],
): { found: boolean; text: string } {
  const preset = (presets ?? []).find(item => item.id === presetId);
  if (!preset) return { found: false, text: '' };
  return { found: true, text: joinEntries(preset.entries, identifiers) };
}

/**
 * 解析最终破限词。
 *
 * 顺序:
 * 1. custom 模式(或没有来源)→ 自定义文本,再回退内置默认;
 * 2. stPreset + imported → 导入快照;快照找不到 → 回退实时当前预设;
 * 3. stPreset + current → 实时当前预设;
 * 4. 最后回退自定义文本 → 内置默认。
 *
 * 与改动前的 `custom || builtin` 逐字一致——没切到预设模式的用户零变化。
 */
export function resolveJailbreakPrompt(options: AutoTagSettings, builtin: string): string {
  const custom = (options.prompts?.jailbreak ?? '').trim();
  const source = options.jailbreakSource;
  if (source?.mode !== 'stPreset') return custom || builtin;

  if (source.presetSource === 'imported') {
    const imported = resolveImportedJailbreak(
      options.importedPresets,
      source.presetId ?? '',
      source.presetEntries ?? [],
    );
    if (imported.text) return imported.text;
    if (imported.found) {
      warnOnce('导入的预设里取不到所选的破限词条目，已回退自定义文本/内置默认');
      return custom || builtin;
    }
    // 快照被删/悬空:继续往下走,用实时当前预设兜底,再不行才回落自定义
    warnOnce('找不到导入的预设(可能已被删除)，已回退当前酒馆预设');
  }

  const presetText = resolvePresetJailbreak(source.presetEntries ?? []);
  if (presetText) return presetText;
  warnOnce('酒馆预设里取不到所选的破限词条目，已回退自定义文本/内置默认');
  return custom || builtin;
}
