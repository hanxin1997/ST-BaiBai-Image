import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import { orientationOfSize, parseSize, type Orientation } from '@/backends/size';
import { FORBIDDEN_SUBTAG, serializeImageTag, type ImageTagContent } from '@/st/imageTagRegex';

/**
 * 世界书生图:主 API 按世界书要求已在正文里写好 `image###…###` 生图词,这里把它原位换成
 * <bbi_image> 卡片,省掉一次副 API 请求。纯函数、无宿主依赖;落盘与出图由 runner 负责。
 *
 * 两种格式由用户在设置里选(settings.autoTag.worldbookFormat),**不从内容猜**:
 * - nai:  `Scene Composition:…;Character 1 Prompt:…|centers:C3;Character 1 UC:…;`
 * - anima:`size:812x1216; Scene:…. Char1:…. Description:…`(anima寻迹 世界书)
 *
 * 字段一律按**键名**切,不按分号/句号切:tag 内容里本来就有分号,Description 里全是句号。
 */

/** 世界书生图格式(与 settings.ts 的 WorldbookFormat 同值;不 import 它,免得纯模块依赖设置)。 */
export type WorldbookImageFormat = 'nai' | 'anima';

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
  /** 找到了 image### 块、但按所选格式一个字段都读不出(或内容非法)而原样保留的块数。 */
  skipped: number;
}

/** 一块生图词:可选的 <image> 壳 + image###…###。壳连同块一起替换,标题行等其余正文不动。 */
const BLOCK_PATTERN = /(?:<image>\s*)?image###([\s\S]*?)###(?:\s*<\/image>)?/gi;

/** 键名只认字段边界处(开头 / 空白 / 分隔符之后),Description 里的普通单词不会被当成键。 */
const KEY_PATTERNS: Record<WorldbookImageFormat, RegExp> = {
  nai: /(?:^|[\s;.,])(Scene Composition|Character\s*(\d+)\s*(Prompt|UC))\s*:/gi,
  anima: /(?:^|[\s;.,])(size|Scene|Char\s*(\d+)|Description)\s*:/gi,
};

/** NAI 版角色 Prompt 末尾的位置后缀。 */
const CENTERS_SUFFIX = /\|\s*centers\s*:\s*([A-Za-z]\d)[^|]*$/i;

/** 未命名角色的显示名前缀(只用于卡片展示,不编人名)。 */
const UNNAMED_CHARACTER = '角色';

interface RawField {
  key: string;
  index: number | null;
  kind: string;
  value: string;
}

interface DraftCharacter {
  tag: string;
  uc: string;
  center: string;
}

/** 去掉末尾充当分隔的标点与空白(tag 字段用;Description 是句子,不走这里)。 */
function trimSeparators(value: string): string {
  return value.replace(/[\s;.,]+$/, '').trim();
}

/** 单行化:生图词可能跨行,而提示词里换行没有意义。 */
function oneLine(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

interface DraftImage {
  base: string;
  nl: string;
  size: Orientation;
  /** 以世界书里的角色编号为键(Character 1 / Char1 → 1)。 */
  characters: Map<number, DraftCharacter>;
}

/** 按键名把块体切成字段。Description 是最后一段自由文本:它之后出现的「键名」一律不算。 */
function splitFields(body: string, format: WorldbookImageFormat): RawField[] {
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
  const created: DraftCharacter = { tag: '', uc: '', center: '' };
  draft.characters.set(index, created);
  return created;
}

/** 角色 Prompt:拆出 NAI 版的 `|centers:C3` 位置后缀,其余是 tag。 */
function applyCharacterPrompt(character: DraftCharacter, value: string): void {
  const centers = CENTERS_SUFFIX.exec(value);
  character.center = centers ? centers[1].toUpperCase() : '';
  character.tag = trimSeparators(centers ? value.slice(0, centers.index) : value);
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
    name: `${UNNAMED_CHARACTER} ${position + 1}`,
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

/**
 * 解析一块生图词。按所选格式读不出 Scene(Base)= 格式对不上,返回 null 让调用方原样保留:
 * 两种格式的 Scene 键名不同,选错格式时恰好一个字段都读不出,这就是「格式不符」的判据。
 */
export function parseWorldbookImage(
  body: string,
  format: WorldbookImageFormat,
  target: WorldbookImageTarget,
): ImageTagContent | null {
  const draft: DraftImage = { base: '', nl: '', size: 'portrait', characters: new Map() };
  for (const field of splitFields(body, format)) applyField(draft, field);
  if (!draft.base) return null;
  const content = toContent(draft, target);
  if (hasForbiddenMarkup(content)) {
    console.warn('[柏宝绘] 世界书生图词里混有 <bbi_image> 等标签字面量,这一块保留原文', body.slice(0, 200));
    return null;
  }
  return content;
}

/** 把正文里所有 image###…### 块原位换成 <bbi_image>;读不出的块原样保留并计数。 */
export function convertWorldbookImages(
  text: string,
  format: WorldbookImageFormat,
  target: WorldbookImageTarget,
): WorldbookConversion {
  let converted = 0;
  let skipped = 0;
  const next = text.replace(new RegExp(BLOCK_PATTERN), (block, body: string) => {
    const content = parseWorldbookImage(body, format, target);
    if (!content) {
      skipped += 1;
      return block;
    }
    converted += 1;
    return serializeImageTag(content);
  });
  return { text: next, converted, skipped };
}

/** 正文里有没有世界书生图词(不管能不能读出来)。 */
export function hasWorldbookImage(text: string): boolean {
  return new RegExp(BLOCK_PATTERN).test(text);
}
