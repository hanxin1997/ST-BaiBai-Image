import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import {
  normalizeOrientation,
  orientationOfSize,
  parseSize,
  type Orientation,
} from '@/backends/size';
import { FORBIDDEN_SUBTAG, serializeImageTag, type ImageTagContent } from '@/st/imageTagRegex';

/**
 * 世界书生图:主 API 按世界书要求已在正文里写好 `image###…###` 生图词,这里把它原位换成
 * <bbi_image> 卡片,省掉一次副 API 请求。纯函数、无宿主依赖;落盘与出图由 runner 负责。
 *
 * 能读的三种格式:
 * - nai:   `Scene Composition:…;Character 1 Prompt:…|centers:C3;Character 1 UC:…;`(绘境物语)
 * - anima: `size:812x1216; Scene:…. Char1:…. Description:…`(anima寻迹 世界书)
 * - prompt:`image###<一整条英文提示词, 末尾 aspect ratio 16:9, 1344x768>###`,
 *          常配 `<image><imgthink>…</imgthink>image###…###</image>` 外壳(图像生成系统模板)
 *
 * **格式不用跟着世界书手动切**:设置里那个值只决定「先按哪种读」('auto' = 按内容认),
 * 读不出就依次换下一种,最后才把整块当完整提示词。格式只决定**怎么读生图词**——
 * 出图渠道、分角色还是拼成一串,始终按用户设置的渠道走(见 runner 的 worldbookTarget)。
 *
 * 字段一律按**键名**切,不按分号/句号切:tag 内容里本来就有分号,Description 里全是句号。
 */

/** 世界书生图能读的格式(与 settings.ts 的 WorldbookFormat 同值;不 import 它,免得纯模块依赖设置)。 */
export type WorldbookImageFormat = 'nai' | 'anima' | 'prompt';

/**
 * 设置里可选的值:'auto' = 每块按内容认格式;其余 = 优先按它读,读不出自动换下一种。
 * 故任何取值都不会让另一种格式的块失效——这正是「不用手动切」的实现方式。
 */
export type WorldbookImageFormatSetting = 'auto' | WorldbookImageFormat;

/**
 * 转换目标形态:characters = 保留 Base + 分角色(NAI / Latent / Latent 原生 API);
 * folded = 拼成一条 tag、各角色 UC 并进负面(ComfyUI / ImgRouter,没有分角色提示)。
 */
export type WorldbookImageTarget = 'characters' | 'folded';

export interface WorldbookConversion {
  /** 转换后的正文(没有可转的块时与原文相同)。 */
  text: string;
  /** 成功换成 <bbi_image> 的块数。 */
  converted: number;
  /** 找到了 image### 块、但按三种格式一个字段都读不出(或内容非法)而原样保留的块数。 */
  skipped: number;
  /** 本次实际用到的格式(按首次出现顺序,去重);用于提示用户读到的是哪一种。 */
  formats: WorldbookImageFormat[];
}

/** 一块生图词:可选的 <image> 壳 + image###…###。壳连同块一起替换,标题行等其余正文不动。 */
const BLOCK_PATTERN = /(?:<image>\s*)?image###([\s\S]*?)###(?:\s*<\/image>)?/gi;

/**
 * 键名只认字段边界处(开头 / 空白 / 分隔符之后),Description 里的普通单词不会被当成键。
 * NAI 同时认全角冒号/分号/逗号/句号:绘境物语是中文书,模型可能把字段标点写成全角。
 */
const KEY_PATTERNS: Record<'nai' | 'anima', RegExp> = {
  nai: /(?:^|[\s;.,；，。])(Scene Composition|Character\s*(\d+)\s*(Prompt|UC))\s*[:：]/gi,
  anima: /(?:^|[\s;.,])(size|Scene|Char\s*(\d+)|Description)\s*:/gi,
};

/**
 * 认格式用的标记。顺序即优先级:NAI 先认——`Scene Composition` 里含 `Scene`,
 * 反过来认 anima 会把它读成 `Scene:` 字段(这正是作者原先坚持「由用户选」的原因)。
 *
 * anima 只认 CharN / Description:单凭一个 `Scene:` 或 `size:` 就下结论太容易误判
 * (完整提示词里也可能出现 `image size:` 这类短语),宁可让它落到完整提示词那一档。
 */
const NAI_MARKER = /(?:^|[\s;.,；，。])(?:Scene\s*Composition|Character\s*\d+\s*(?:Prompt|UC))\s*[:：]/i;
const ANIMA_MARKER = /(?:^|[\s;.,；，。])(?:Char\s*\d+|Description)\s*[:：]/i;

/**
 * 结构化块的残骸判据(完整提示词这一档见到就拒收):
 * - 块体一开头就是键名 → 这是结构化块的写法,只是字段没写全;
 * - NAI 的键名出现在任何位置 → 正常提示词里不会这么写。
 * 只看「开头」而不看全文,是为了放过 `…, description: …` 这种恰好带冒号的正常提示词。
 */
const STRUCTURED_START =
  /^\s*(?:size|Scene(?:\s*Composition)?|Char\s*\d+|Character\s*\d+|Description)\s*[:：]/i;
const NAI_KEY_ANYWHERE = /(?:Scene\s*Composition|Character\s*\d+\s*(?:Prompt|UC))\s*[:：]/i;

/** NAI 版角色 Prompt 末尾的位置后缀(全角冒号同样容忍)。 */
const CENTERS_SUFFIX = /\|\s*centers\s*[:：]\s*([A-Za-z]\d)[^|]*$/i;

/** 未命名角色的显示名前缀(只用于卡片展示,不编人名)。 */
const UNNAMED_CHARACTER = '角色';

/**
 * 完整提示词末尾的分辨率尾巴(世界书要求「分辨率须为最后一项」)。
 * 只认两种写法,且必须贴着末尾:宽高比裸写(如 `16:9`)不收——它和 `18:30` 这种正文无从区分。
 */
const RESOLUTION_TAIL_PATTERNS: readonly RegExp[] = [
  // aspect ratio 16:9 / aspect ratio: 16:9, 1344x768 / (aspect ratio 16:9)
  /[\s,，;；]*[(（]?\s*aspect\s*ratio\s*[:：]?\s*\d{1,3}\s*[:：]\s*\d{1,3}\s*(?:[,，;；]\s*\d{2,4}\s*[x×*]\s*\d{2,4})?\s*[)）]?\s*[.。]?\s*$/i,
  // 1344x768 / 16:9, 1344x768 / (1344x768)
  /[\s,，;；]*[(（]?\s*(?:\d{1,3}\s*[:：]\s*\d{1,3}\s*[,，;；]\s*)?\d{2,4}\s*[x×*]\s*\d{2,4}\s*[)）]?\s*[.。]?\s*$/i,
];

/** 思考块(图像生成系统的 <imgthink> / anima 的 <Tag_think>):只给模型自己看,不进正文。 */
const THINK_BLOCK = /<(?:imgthink|tag_think)\b[^>]*>[\s\S]*?<\/(?:imgthink|tag_think)>/gi;
/** 图片外壳标签。`bbi_image` 不在其列(前缀是 `bbi_`,这里认的是紧跟 `<` 的 image)。 */
const IMAGE_SHELL_TAG = /<\/?images?[^>]*>/gi;
/** anima 世界书在 <image> 里留的占位行 `regex:xxxx`,不是正文。 */
const REGEX_META_LINE = /^[ \t]*regex\s*[:：].*$/gim;

interface RawField {
  key: string;
  index: number | null;
  kind: string;
  value: string;
}

interface DraftCharacter {
  /** 角色名(角色段写成 `名字 | tag` 时解析出来;没有则空,出图时用「角色 N」)。 */
  name: string;
  tag: string;
  uc: string;
  center: string;
}

/** 去掉末尾充当分隔的标点与空白(tag 字段用;Description 是句子,不走这里)。 */
function trimSeparators(value: string): string {
  return value.replace(/[\s;.,；，。]+$/, '').trim();
}

/** 单行化:生图词可能跨行,而提示词里换行没有意义。 */
function oneLine(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/** 像不像一条提示词:有实义、且带英文单词。纯中文残句不当提示词,免得把正文误转成图。 */
function looksLikePrompt(text: string): boolean {
  if (text.length < 6) return false;
  return /[a-zA-Z]{2,}/.test(text);
}

/** 剥掉末尾的分辨率尾巴,并换算成画幅方向;没有尾巴时 size = null(留给默认竖屏)。 */
function splitResolution(text: string): { text: string; size: Orientation | null } {
  for (const pattern of RESOLUTION_TAIL_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const tail = match[0];
    const px = parseSize(tail);
    return {
      text: text.slice(0, match.index),
      size: px ? orientationOfSize(px) : normalizeOrientation(tail),
    };
  }
  return { text, size: null };
}

/** 按内容认格式;认不出返回 null(auto 下会依次试全部格式)。 */
export function detectWorldbookImageFormat(body: string): WorldbookImageFormat | null {
  if (NAI_MARKER.test(body)) return 'nai';
  if (ANIMA_MARKER.test(body)) return 'anima';
  if (STRUCTURED_START.test(oneLine(body))) return null;
  return looksLikePrompt(oneLine(body)) ? 'prompt' : null;
}

/**
 * 候选格式顺序:优先设置里选的那个(auto = 按内容认),然后是另外两种结构化格式,
 * 完整提示词**永远排最后**——它是兜底档,先试它会把结构化块里的键名一起吞进提示词。
 */
function candidateFormats(
  body: string,
  setting: WorldbookImageFormatSetting,
): WorldbookImageFormat[] {
  const structured: Array<'nai' | 'anima'> = ['nai', 'anima'];
  const detected = setting === 'auto' ? detectWorldbookImageFormat(body) : setting;
  const preferred = detected === 'anima' ? 'anima' : detected === 'nai' ? 'nai' : null;
  const order: Array<'nai' | 'anima'> = preferred
    ? [preferred, ...structured.filter(format => format !== preferred)]
    : [...structured];
  return [...order, 'prompt'];
}

interface DraftImage {
  base: string;
  nl: string;
  size: Orientation;
  /** 以世界书里的角色编号为键(Character 1 / Char1 → 1)。 */
  characters: Map<number, DraftCharacter>;
}

/** 按键名把块体切成字段。Description 是最后一段自由文本:它之后出现的「键名」一律不算。 */
function splitFields(body: string, format: 'nai' | 'anima'): RawField[] {
  const all = [...body.matchAll(new RegExp(KEY_PATTERNS[format]))];
  const descriptionAt = all.findIndex(match => match[1].toLowerCase() === 'description');
  const matches = descriptionAt >= 0 ? all.slice(0, descriptionAt + 1) : all;
  return matches.map((match, position) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = position + 1 < matches.length ? (matches[position + 1].index ?? body.length) : body.length;
    return {
      key: match[1].toLowerCase().replace(/\s+/g, ' '),
      index: match[2] ? Number(match[2]) : null,
      kind: (match[3] ?? '').toLowerCase(),
      value: body.slice(start, end).trim(),
    };
  });
}

function characterDraft(draft: DraftImage, index: number): DraftCharacter {
  const existing = draft.characters.get(index);
  if (existing) return existing;
  const created: DraftCharacter = { name: '', tag: '', uc: '', center: '' };
  draft.characters.set(index, created);
  return created;
}

/**
 * 角色 Prompt:拆出 NAI 版的 `|centers:C3` 位置后缀,再拆 `名字 | tag`。
 * 没有竖线时整段都是 tag、名字为空(兼容旧世界书);有名字才会被世界书生图自动建档。
 */
function applyCharacterPrompt(character: DraftCharacter, value: string): void {
  const centers = CENTERS_SUFFIX.exec(value);
  const body = centers ? value.slice(0, centers.index) : value;
  character.center = centers ? centers[1].toUpperCase() : '';
  const pipe = body.indexOf('|');
  if (pipe >= 0) {
    character.name = body.slice(0, pipe).trim();
    character.tag = trimSeparators(body.slice(pipe + 1));
  } else {
    character.tag = trimSeparators(body);
  }
}

function applyField(draft: DraftImage, field: RawField): void {
  if (field.key === 'description') {
    draft.nl = oneLine(field.value);
    return;
  }
  const value = oneLine(trimSeparators(field.value));
  if (field.key === 'scene composition' || field.key === 'scene') draft.base = value;
  else if (field.key === 'size') {
    const px = parseSize(value);
    if (px) draft.size = orientationOfSize(px);
  } else if (field.index !== null) {
    const character = characterDraft(draft, field.index);
    if (field.kind === 'uc') character.uc = value;
    else applyCharacterPrompt(character, value);
  }
}

/** 按世界书编号排好序、丢掉空 tag 的角色。 */
function orderedCharacters(draft: DraftImage): DraftCharacter[] {
  return [...draft.characters.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, character]) => character)
    .filter(character => character.tag);
}

/** 草稿 → <bbi_image> 内容。folded 时角色 tag 依次接在 Base 后面、UC 并进负面。 */
function toContent(draft: DraftImage, target: WorldbookImageTarget): ImageTagContent {
  const characters = orderedCharacters(draft);
  if (target === 'folded') {
    return {
      tag: [draft.base, ...characters.map(character => character.tag)].filter(Boolean).join(', '),
      nl: draft.nl,
      negative: characters.map(character => character.uc).filter(Boolean).join(', '),
      characters: [],
      size: draft.size,
    };
  }
  const prompts: ImageCharacterPrompt[] = characters.map((character, position) => ({
    name: character.name || `${UNNAMED_CHARACTER} ${position + 1}`,
    tag: character.tag,
    nl: '',
    ...(character.center ? { center: character.center } : {}),
    ...(character.uc ? { uc: character.uc } : {}),
  }));
  return { tag: draft.base, nl: draft.nl, negative: '', characters: prompts, size: draft.size };
}

/** 内容里混进 <bbi_image> 等子标签字面量会破坏解析(见 FORBIDDEN_SUBTAG),这一块不转。 */
function hasForbiddenMarkup(content: ImageTagContent): boolean {
  const texts = [content.tag, content.nl, content.negative, ...content.characters.flatMap(c => [c.tag, c.uc ?? ''])];
  return texts.some(text => FORBIDDEN_SUBTAG.test(text));
}

/** 按一种格式解析块体;读不出返回 null(交给下一种格式)。 */
function parseAs(
  body: string,
  format: WorldbookImageFormat,
  target: WorldbookImageTarget,
): ImageTagContent | null {
  if (format === 'prompt') {
    const text = oneLine(body);
    if (!looksLikePrompt(text) || STRUCTURED_START.test(text) || NAI_KEY_ANYWHERE.test(text)) return null;
    const split = splitResolution(text);
    const tag = trimSeparators(split.text);
    if (!tag) return null;
    // 完整提示词只有一整条正向词:分角色/负面都留空,画幅按末尾的分辨率算。
    return { tag, nl: '', negative: '', characters: [], size: split.size ?? 'portrait' };
  }

  const draft: DraftImage = { base: '', nl: '', size: 'portrait', characters: new Map() };
  for (const field of splitFields(body, format)) applyField(draft, field);
  // 按所选格式读不出 Scene(Base)= 格式对不上,返回 null 让调用方换下一种格式。
  if (!draft.base) return null;
  const content = toContent(draft, target);
  if (hasForbiddenMarkup(content)) {
    console.warn('[柏宝绘] 世界书生图词里混有 <bbi_image> 等标签字面量,这一块保留原文', body.slice(0, 200));
    return null;
  }
  return content;
}

interface ParsedBlock {
  format: WorldbookImageFormat;
  content: ImageTagContent;
}

function parseBlock(
  body: string,
  format: WorldbookImageFormatSetting,
  target: WorldbookImageTarget,
): ParsedBlock | null {
  for (const candidate of candidateFormats(body, format)) {
    const content = parseAs(body, candidate, target);
    if (content) return { format: candidate, content };
  }
  return null;
}

/**
 * 解析一块生图词。三种格式依次试,读不出才原样保留:
 * 一个字段都读不出 = 世界书写的既不是这三种之一(或内容非法),这才是「格式不符」的判据。
 */
export function parseWorldbookImage(
  body: string,
  format: WorldbookImageFormatSetting,
  target: WorldbookImageTarget,
): ImageTagContent | null {
  return parseBlock(body, format, target)?.content ?? null;
}

/**
 * 清掉块外面的世界书外壳:`<imgthink>`/`<Tag_think>` 思考块、`<image>`/`</image>` 壳、
 * `regex:` 占位行。**只在真转过至少一块时才做**——一块都没转的楼保持原文逐字不动。
 */
function cleanShell(text: string): string {
  return text
    .replace(THINK_BLOCK, '')
    .replace(IMAGE_SHELL_TAG, '')
    .replace(REGEX_META_LINE, '')
    .replace(/\n{3,}/g, '\n\n');
}

/** 把正文里所有 image###…### 块原位换成 <bbi_image>;读不出的块原样保留并计数。 */
export function convertWorldbookImages(
  text: string,
  format: WorldbookImageFormatSetting,
  target: WorldbookImageTarget,
): WorldbookConversion {
  let converted = 0;
  let skipped = 0;
  const formats: WorldbookImageFormat[] = [];
  const next = text.replace(new RegExp(BLOCK_PATTERN), (block, body: string) => {
    const parsed = parseBlock(body, format, target);
    if (!parsed) {
      skipped += 1;
      return block;
    }
    converted += 1;
    if (!formats.includes(parsed.format)) formats.push(parsed.format);
    return serializeImageTag(parsed.content);
  });
  return { text: converted ? cleanShell(next) : next, converted, skipped, formats };
}

/** 正文里有没有世界书生图词(不管能不能读出来)。 */
export function hasWorldbookImage(text: string): boolean {
  return new RegExp(BLOCK_PATTERN).test(text);
}
