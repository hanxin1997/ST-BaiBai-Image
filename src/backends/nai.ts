import { unzipSync } from 'fflate';
import { randomUuid } from '@/randomUuid';

import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import type { ComfyImageResult } from '@/backends/comfyui';
import {
  parseRetryAfter,
  runNaiWithRetry,
  type NaiRetryInfo,
} from '@/backends/naiRateLimit';
import { buildPromptSections, joinSections } from '@/backends/promptSections';
import { parseSize, pickSize, type Orientation } from '@/backends/size';
import { clampVibeStrength, loadVibeData } from '@/backends/vibeStore';
import { decodeMessagePack, type MessagePackValue } from '@/msgpack';
import type { GenerationArtist, GenerationMeta, GenerationParams, GenerationVibe } from '@/generationMeta';
import type {
  NaiArtistPreset,
  NaiSettings,
  NaiVibe,
  NaiVibeData,
  NaiVibeEncodings,
} from '@/state/settings';

/**
 * NovelAI 生图后端(浏览器直连,协议与官方 image.novelai.net 一致)。
 * url 可指向任意兼容站:官方/镜像/第三方转发,端点自动补 /ai 前缀。
 *
 * 协议分两条:
 * - V5(nativeV5):POST {base}/ai/generate-image-stream,multipart 字段 request 装 JSON,
 *   响应是 MessagePack 流(4 字节大端帧长 + 事件对象),取 final 事件的 image。
 *   字段口径对齐官方 V5:qualityPresetId / ucPresetId / straight_alpha / use_coords 等。
 * - 旧链路(V3/V4/V4.5,以及 V5 端点明确不支持流式时的回落):
 *   POST {base}/ai/generate-image,body {input, model, action:'generate', parameters},
 *   响应是 zip,解出第一张图。
 *
 * Vibe:NAI3 直接发参考原图;NAI4/4.5/V5 必须先经 /ai/encode-vibe 编码,
 * 生成时以 reference_image_multiple_cached(uuid + 编码数据) 形式叠加。
 * .naiv4vibe 文件格式与官方互通(encodings 按模型 key 分组)。
 *
 * latent.moe 走的是 latentApi.ts,与本文件的传输层无关;本文件只按 flatten 标志
 * 决定提示词形态,不改变 latent 渠道的接口。
 */

export class NaiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /**
     * 对方 Retry-After 换算出的毫秒数(没给则 null)。
     * 由 naiRateLimit 的重试器当退避下界用 —— 这是「该等多久」最权威的一手信息,
     * 扔掉它就只能凭指数退避瞎猜。
     */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'NaiError';
  }
}

/* ============ 常量表(与 st-chatu8 / NAI 官方前端同口径) ============ */

export const NAI_SAMPLERS: { value: string; label: string }[] = [
  { value: 'k_euler', label: 'Euler' },
  { value: 'k_euler_ancestral', label: 'Euler Ancestral' },
  { value: 'k_dpmpp_2s_ancestral', label: 'DPM++ 2S Ancestral' },
  { value: 'k_dpmpp_2m', label: 'DPM++ 2M' },
  { value: 'k_dpmpp_2m_sde', label: 'DPM++ 2M SDE' },
  { value: 'k_dpmpp_sde', label: 'DPM++ SDE' },
  { value: 'ddim_v3', label: 'DDIM V3' },
];

export const NAI_NOISE_SCHEDULES: { value: string; label: string }[] = [
  { value: 'karras', label: 'Karras(推荐)' },
  { value: 'native', label: 'Native' },
  { value: 'exponential', label: 'Exponential' },
  { value: 'polyexponential', label: 'Polyexponential' },
];

/** 各模型官方质量词，拼到正向提示词末尾;用户在面板改过则用其覆盖值。 */
const QUALITY_TAGS: Record<string, string> = {
  'nai-diffusion-5-full': 'very aesthetic, masterpiece, no text',
  'nai-diffusion-5-curated': 'very aesthetic, masterpiece, no text',
  'nai-diffusion-4-5-full': 'location, very aesthetic, masterpiece, no text',
  'nai-diffusion-4-5-curated': 'location, masterpiece, no text, -0.8::feet::, rating:general',
  'nai-diffusion-4-full': 'no text, best quality, very aesthetic, absurdres',
  'nai-diffusion-4-curated-preview': 'rating:general, best quality, very aesthetic, absurdres',
  'nai-diffusion-3': 'best quality, amazing quality, very aesthetic, absurdres',
};

/**
 * 各模型官方 Heavy 负面词，作为无需用户选择的通用默认;用户改过则用其覆盖值。
 * 5-full 在官方基线后额外串一条插件精选的通用负面层:只排画质/解剖/水印等**缺陷**,
 * 不含题材、风格、身材、画师偏好——那些会跟用户的正向词和画师串长期打架。
 * 其余模型维持官方基线不动。
 */
const DEFAULT_UNDESIRED_CONTENT: Record<string, string> = {
  'nai-diffusion-5-full':
    'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, text, watermark, signature, username, artist name, bad anatomy, bad hands, bad feet, extra digits, fewer digits, extra fingers, fused fingers, extra limbs, missing limbs, long neck, blurry, poorly drawn, unfinished, plastic skin, waxy skin, oversaturated, washed out',
  'nai-diffusion-5-curated':
    'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page',
  'nai-diffusion-3':
    'lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract]',
  'nai-diffusion-4-full':
    'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, too many watermarks, white blank page, blank page',
  'nai-diffusion-4-curated-preview':
    'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, logo, dated, signature, multiple views, gigantic breasts, white blank page, blank page',
  'nai-diffusion-4-5-curated':
    'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page',
  'nai-diffusion-4-5-full':
    'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page',
};

/**
 * 某模型的官方质量词 / 官方 Heavy 负面词。面板拿它做「未自定义」时的显示内容
 * 与「恢复默认」的目标,故必须导出:否则用户看不到实际生效的词(改动前的老问题)。
 */
export function naiDefaultQualityTags(model: string): string {
  return QUALITY_TAGS[model] ?? '';
}

export function naiDefaultUndesired(model: string): string {
  return DEFAULT_UNDESIRED_CONTENT[model] ?? '';
}

/** variety boost 的 magic 常数(st-chatu8 同口径):按像素量相对参考分辨率缩放。 */
const REFERENCE_PIXEL_COUNT = 1011712;
const SIGMA_MAGIC_NUMBER = 19;
const SIGMA_MAGIC_NUMBER_V4_5 = 58;

export function isNai5(model: string): boolean {
  return model.includes('nai-diffusion-5');
}

export function naiSupportsVibes(model: string): boolean {
  return isNai3(model) || isNai4Family(model) || isNai5(model);
}

const NAI_V5_SAMPLERS = new Set([
  'k_euler_ancestral',
  'k_euler',
  'k_dpmpp_2s_ancestral',
  'k_dpmpp_2m_sde',
  'k_dpmpp_2m',
  'k_dpmpp_sde',
]);

export function naiSamplers(model: string): { value: string; label: string }[] {
  return isNai5(model) ? NAI_SAMPLERS.filter(sampler => NAI_V5_SAMPLERS.has(sampler.value)) : NAI_SAMPLERS;
}

export function isNai45(model: string): boolean {
  return model.includes('nai-diffusion-4-5');
}

/**
 * 该模型是否走「Base Prompt + 原生 Character Prompts + 自然语言」这套协议。
 *
 * 边界是 4.5 而不是整个 v4 系:自然语言是 4.5 才引入的,原版 NAI4
 * (nai-diffusion-4-full / 4-curated-preview)只吃 tag。给它发英文 nl 句子
 * 属于未验证行为,故保持原样走单串 tag 规范。
 *
 * ⚠ 不要改回 isNai5:char_captions 所在的字段本来就叫 v4_prompt,这套结构是 V4 时代的
 * 协议,V5 只是继承。曾经按 isNai5 卡过,导致 4.5 明明支持却一条角色提示都发不出去。
 */
export function naiSupportsCharacterPrompts(model: string): boolean {
  return isNai45(model) || isNai5(model);
}

export function isNai4Family(model: string): boolean {
  return model.includes('nai-diffusion-4');
}

function isNai3(model: string): boolean {
  return model === 'nai-diffusion-3';
}

/** skip_cfg_above_sigma:开 variety boost 时按尺寸与模型算;关 → null。 */
export function skipCfgAboveSigma(width: number, height: number, model: string, varietyBoost: boolean): number | null {
  if (!varietyBoost || isNai5(model)) return null;
  const magic = isNai45(model) ? SIGMA_MAGIC_NUMBER_V4_5 : SIGMA_MAGIC_NUMBER;
  return Math.pow((width * height) / REFERENCE_PIXEL_COUNT, 0.5) * magic;
}

/* ============ 地址与基础工具 ============ */

/**
 * 拼端点:base 去掉尾斜杠后补 /ai/<path>;base 本身已是完整端点
 * (以 /ai/<path> 或 /<path> 结尾)时原样使用,方便第三方站给整段 URL。
 */
export function naiEndpoint(url: string, path: string): string {
  const base = url.trim().replace(/\/+$/, '');
  if (!base) throw new NaiError('请先填写 NAI 接口地址');
  const seg = path.replace(/^\/+/, '');
  if (base.endsWith(`/ai/${seg}`) || base.endsWith(`/${seg}`)) return base;
  return `${base}/ai/${seg}`;
}

/**
 * 生图端点。用户的地址可能写成 base(https://image.novelai.net)、
 * 完整旧端点(.../ai/generate-image)或完整流端点(.../ai/generate-image-stream),
 * 三种都要能互换,不能简单拼 /ai。
 */
function naiImageEndpoint(url: string, stream: boolean): string {
  const base = url.trim().replace(/\/+$/, '');
  if (!base) throw new NaiError('请先填写 NAI 接口地址');
  const target = stream ? 'generate-image-stream' : 'generate-image';
  const fullEndpoint = /\/ai\/generate-image(?:-stream)?$/i;
  if (fullEndpoint.test(base)) return base.replace(fullEndpoint, `/ai/${target}`);
  const bareEndpoint = /\/generate-image(?:-stream)?$/i;
  if (bareEndpoint.test(base)) return base.replace(bareEndpoint, `/${target}`);
  return `${base}/ai/${target}`;
}

export interface NaiSize {
  width: number;
  height: number;
}

/** 解析「832×1216 / 832x1216」;宽高须为 64 的倍数、256–2048。 */
export function parseResolution(text: string): NaiSize {
  const size = parseSize(text);
  if (!size) throw new NaiError(`分辨率格式无效:${text || '(空)'};应如 832×1216`);
  const { width, height } = size;
  if (width % 64 !== 0 || height % 64 !== 0) {
    throw new NaiError(`分辨率 ${width}×${height} 不是 64 的倍数,NAI 要求宽高均为 64 的倍数`);
  }
  if (width < 256 || height < 256 || width > 2048 || height > 2048) {
    throw new NaiError(`分辨率 ${width}×${height} 超出 NAI 允许范围(256–2048)`);
  }
  return { width, height };
}

/** NAI 种子是 32 位无符号整数(与 ComfyUI 的 2^53 不同,不能复用 randomSeed)。 */
export function naiRandomSeed(): number {
  return Math.floor(Math.random() * 2 ** 32);
}

function uint8ToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ============ payload 构造(纯函数,可测) ============ */

export interface NaiGenerateValues {
  /** 正向 tag(不含质量词)。 */
  prompt: string;
  nl?: string;
  characters?: ImageCharacterPrompt[];
  /** 种子;缺省随机。 */
  seed?: number;
  /** 画幅方向;缺省竖屏(与改动前的固定默认一致)。 */
  size?: Orientation;
  /**
   * latent 渠道:把正向 tag / 自然语言 / 各角色摊成分段串塞进正向提示词
   * (格式见 backends/promptSections.ts),并清空结构化 Character Prompts。
   *
   * 刻意**不**做成 settings 里的用户开关:它是 latent 这条渠道的定义而非可调项,
   * 给个开关只会让人关掉之后困惑「为什么角色没生效」。由 Card.vue 按当前后端传入。
   */
  flatten?: boolean;
}

/** fullPositivePrompt 的可选入参。用对象而非继续加位参:现有调用点与测试不受影响。 */
export interface FullPositiveOpts {
  characters?: readonly ImageCharacterPrompt[];
  flatten?: boolean;
}

/**
 * 内置画师串配方:只读,**不进 settings**,改它们 = 改这里的常量、发版即生效。
 *
 * 为什么不做成「首次启动播种进 settings」:写进 settings 那一刻默认值就冻在
 * 每个用户的设备上(还随 extension_settings 跨设备同步),以后再改只能靠
 * 「与旧种子逐字节比对」的指纹迁移,每改一次背一份旧种子。内置在代码里,
 * 默认值永远跟着版本走,已安装用户的 settings 一个字节不用动。
 *
 * 口径:
 * - id 用 bi_ 前缀(用户条目恒为 art_*),永不与用户库相撞;
 * - 只读:面板不给改名/删除,要自定义走「复制」建成用户条目再改;
 * - quality/negative 与用户条目同一条回落链,留空 = 跟随渠道级;
 * - 新用户默认选中第一条(见 settings.ts 的 naiDefaults);老用户的
 *   activeArtistId 存在 settings 里,不受这里影响;
 * - 要下线某条内置配方,至少留一个版本再删:正选中它的用户会走既有
 *   「id 悬空 → 清成不使用」逻辑,画风静默变掉,需慎重。
 */
export const BUILTIN_NAI_ARTISTS: readonly NaiArtistPreset[] = [
  {
    id: 'bi_default',
    name: '默认画师串',
    prompt:
      '0.8::nnmbpx::,0.8::artist:yalmyu::,0.1::smilesmile1312,::,  artist:sh_(shinh), 0.4::chen bin::,0.4::dayama::,healthyman,bacheally,',
    quality: '',
    negative: '',
  },
];

/** 该 id 是否是内置配方(面板据此只读化;用户条目 id 恒为 art_*,不可能撞上)。 */
export function isBuiltinNaiArtist(id: string): boolean {
  return BUILTIN_NAI_ARTISTS.some(a => a.id === id);
}

type JsonObject = Record<string, unknown>;

/**
 * 当前生效的画风配方;未选 / 指向已删条目 → null。
 * 查找域 = 用户库 ∪ 内置库(用户库优先;id 前缀不同,实际不可能撞)。
 *
 * 刻意吃 nai 而不读全局 settings:本文件的拼装函数都是纯函数、可单测,读全局会让测试
 * 没法用 nai() 工厂控制输入。也刻意不 import state/settings 的 activeNaiArtist ——
 * settings.ts 已 import 本模块的 naiDefaultUndesired,反向加值依赖会成运行时环(TDZ 隐患)。
 * 这一行 find 的重复是有意为之。
 */
function naiActivePreset(nai: NaiSettings): NaiArtistPreset | null {
  if (!nai.activeArtistId) return null;
  return (
    nai.artistPresets.find(a => a.id === nai.activeArtistId) ??
    BUILTIN_NAI_ARTISTS.find(a => a.id === nai.activeArtistId) ??
    null
  );
}

/** 当前生效的画师串快照（id / 名字 / 正文）。未选或正文全空白 → null。
 *  拼装（naiArtistPrompt）与随图记录（generateNaiImage 的 usage）都走这里，保证
 *  「真发出去的画师串」与「记下来的画师串」永远同源。 */
export function naiArtistUsage(nai: NaiSettings): GenerationArtist | null {
  const preset = naiActivePreset(nai);
  const prompt = preset?.prompt.trim() ?? '';
  // 全空白的 preset 必须归 null:'   ' 是 truthy,下游 filter(Boolean) 兜不住它
  if (!preset || !prompt) return null;
  return { id: preset.id, name: preset.name, prompt };
}

/** 当前生效的画师串:选中条目的正文;未选 / 指向已删条目 / 内容全空白 → 空串。 */
export function naiArtistPrompt(nai: NaiSettings): string {
  return naiArtistUsage(nai)?.prompt ?? '';
}

/**
 * 正面质量词解析链:配方绑定值 → 渠道覆盖值(qualityTags)→ 内置默认。
 * 任一级空串(或纯空白)= 跟随下一级。内置默认当前 = 模型官方词;
 * 以后插件要换成自己的精选默认,只改 naiDefaultQualityTags,链结构不变。
 */
export function naiQualityTags(nai: NaiSettings): string {
  const bound = naiActivePreset(nai)?.quality.trim();
  return bound || nai.qualityTags.trim() || naiDefaultQualityTags(nai.model);
}

/** 负面提示词解析链:配方绑定值 → 渠道覆盖值(undesiredContent)→ 内置默认(模型官方负面词)。 */
export function naiUndesiredContent(nai: NaiSettings): string {
  const bound = naiActivePreset(nai)?.negative.trim();
  return bound || nai.undesiredContent.trim() || naiDefaultUndesired(nai.model);
}

/**
 * 正向完整 prompt:画师串在最前,画面 tag 居中,质量词在最后。
 * - 画师串 = 画风配方库当前选中条目(未选则无)。放最前是因为它决定整幅画的画风基调,
 *   NAI 对靠前 tag 的权重更高;
 * - 质量词 = 配方绑定值优先,其次渠道覆盖值(qualityTags),都留空则按模型取官方词
 *   (见 naiQualityTags)。
 *
 * ⚠ 本函数在 buildNaiParameters(v4_prompt 的来源)与 generateNaiImage 的顶层 input
 * 字段处各调一次,两处必须同源。拼装改动一律留在本函数内部——在某个调用点单独加料会让
 * NAI3(读 input)与 NAI4/4.5(读 v4_prompt)拿到不同的提示词,且只在 NAI3 上暴露。
 */
export function fullPositivePrompt(
  nai: NaiSettings,
  prompt: string,
  nl = '',
  opts: FullPositiveOpts = {},
): string {
  const artist = naiArtistPrompt(nai);
  const quality = naiQualityTags(nai);
  const tags = [artist, prompt.trim(), quality].filter(Boolean).join(', ');
  // latent:摊成分段串。画师串与质量词仍并进「正向提示词」段,次序不变——
  // 换行分段只改「怎么装」,不改「装什么」,故两种模式的 tag 内容逐字相同。
  if (opts.flatten) {
    return joinSections(
      buildPromptSections({
        prompt: tags,
        nl: nl.trim(),
        // 角色段照 Character Prompts 的口径normalize:见 singleSubjectTag
        characters: (opts.characters ?? []).map(character => ({
          name: character.name,
          tag: singleSubjectTag(character.tag),
          nl: character.nl.trim(),
        })),
      }),
    );
  }
  return naiSupportsCharacterPrompts(nai.model) && nl.trim() ? `${tags}. ${nl.trim()}` : tags;
}

/**
 * Character Prompts identify one subject: library count tags (1girl/1boy) become girl/boy here.
 *
 * 单独抽出是因为 latent 的角色段要用同一口径:那里每段也只讲一个角色,
 * 留着 `1girl` 会告诉模型这一段里还另有一个女孩,把一个人拆成两个。
 */
function singleSubjectTag(tag: string): string {
  return tag
    .split(',')
    .map(part => {
      const value = part.trim();
      if (/^\d+\s*girls?$/i.test(value)) return 'girl';
      if (/^\d+\s*boys?$/i.test(value)) return 'boy';
      return value;
    })
    .filter(Boolean)
    .join(', ');
}

function characterCaption(character: ImageCharacterPrompt): string {
  const tag = singleSubjectTag(character.tag);
  return character.nl.trim() ? `${tag}. ${character.nl.trim()}` : tag;
}

/** 未指定位置时的角色中心(官方前端「AI 决定位置」时发的也是它)。 */
const DEFAULT_CHARACTER_CENTER = { x: 0.5, y: 0.5 };
/** NAI 5×5 位置网格:列 A–E、行 1–5,各取格子中心;C3 = 正中。 */
const CENTER_GRID_COLUMNS = 'ABCDE';
const CENTER_GRID_STEPS = [0.1, 0.3, 0.5, 0.7, 0.9];

/** 网格标签(如 C3)→ 坐标;认不出 → null(当作未指定)。 */
export function characterCenterPoint(label: string | undefined): { x: number; y: number } | null {
  const match = /^([A-E])([1-5])$/i.exec((label ?? '').trim());
  if (!match) return null;
  const x = CENTER_GRID_STEPS[CENTER_GRID_COLUMNS.indexOf(match[1].toUpperCase())];
  const y = CENTER_GRID_STEPS[Number(match[2]) - 1];
  return { x, y };
}

/**
 * v4 系的分角色正/负面 caption。
 *
 * 位置与分角色负面只有世界书生图会带(见 ImageCharacterPrompt 注释);都不带时产出与加这两项
 * 之前逐字节相同 —— 每个角色恒在正中、负面空串、useCoords=false。
 */
function characterCaptions(characters: readonly ImageCharacterPrompt[]) {
  const centers = characters.map(character => characterCenterPoint(character.center));
  return {
    positive: characters.map((character, index) => ({
      char_caption: characterCaption(character),
      centers: [centers[index] ?? DEFAULT_CHARACTER_CENTER],
    })),
    negative: characters.map((character, index) => ({
      char_caption: (character.uc ?? '').trim(),
      centers: [centers[index] ?? DEFAULT_CHARACTER_CENTER],
    })),
    // 有任一角色指定了位置才让 NAI 按坐标摆放;否则交给模型自己排(与改动前一致)
    useCoords: centers.some(Boolean),
  };
}

/**
 * 负面完整 prompt = 配方绑定值 → 渠道覆盖值(undesiredContent)→ 模型官方负面词
 * (见 naiUndesiredContent)。想额外排除什么,往任一级的值里接即可。
 */
export function fullNegativePrompt(nai: NaiSettings): string {
  return naiUndesiredContent(nai);
}

/**
 * 构造 parameters。v4 系模型带 v4_prompt/v4_negative_prompt 结构;NAI3 不带。
 * vibe 不在此叠加(见 applyVibes),保持「一次生成 = build + applyVibes」两步。
 */
/** V5 原生链路 = 模型是 V5 且不是 latent 的摊平模式(latent 仍走旧协议)。 */
function usesNativeV5(nai: NaiSettings, flatten: boolean | undefined): boolean {
  return isNai5(nai.model) && !flatten;
}

export function buildNaiParameters(nai: NaiSettings, values: NaiGenerateValues): JsonObject {
  // 画幅按方向取用户配的那一格;没填回落竖屏默认
  const orientation = values.size ?? 'portrait';
  const { width, height } = parseResolution(pickSize(nai, orientation) || '832×1216');
  // 显式传入 > 面板固定种子 > 随机
  const seed = values.seed ?? (nai.seed > 0 ? nai.seed : naiRandomSeed());
  const prompt = fullPositivePrompt(nai, values.prompt, values.nl, {
    characters: values.characters,
    flatten: values.flatten,
  });
  const negative = fullNegativePrompt(nai);
  const skipCfg = skipCfgAboveSigma(width, height, nai.model, nai.varietyBoost);
  const sampler = isNai5(nai.model) && !NAI_V5_SAMPLERS.has(nai.sampler) ? 'k_euler_ancestral' : nai.sampler;
  const nativeV5 = usesNativeV5(nai, values.flatten);

  const params: JsonObject = {
    params_version: isNai5(nai.model) ? 4 : 3,
    width,
    height,
    scale: nai.scale,
    sampler,
    steps: nai.steps,
    n_samples: 1,
    dynamic_thresholding: false,
    controlnet_strength: 1,
    legacy: false,
    legacy_uc: false,
    add_original_image: true,
    cfg_rescale: nai.cfgRescale,
    noise_schedule: nai.noiseSchedule,
    legacy_v3_extend: false,
    stream: 'msgpack',
    seed,
    negative_prompt: negative,
    reference_strength_multiple: [],
    normalize_reference_strength_multiple: nai.normalizeRefStrength,
    use_coords: false,
    // V5 官方字段与旧版互斥:发 ucPreset/qualityToggle 会被当成旧协议,
    // 发 skip_cfg_above_sigma: null 也不在 V5 契约里(LWB 直接省略)。
    ...(nativeV5
      ? {
          qualityPresetId: 'standard',
          ucPresetId: 'heavy',
          autoSmea: false,
          inpaintImg2ImgStrength: 1,
          straight_alpha: true,
          image_format: 'png',
        }
      : {
          // 提示词已由本地固定默认拼好;协议字段保持官方前端口径。
          ucPreset: 3,
          qualityToggle: true,
          skip_cfg_above_sigma: skipCfg,
        }),
  };

  if (isNai3(nai.model)) {
    // NAI3:vibe 直接发参考原图;SME/SMEA 暂不开放(固定关)
    params.sm = false;
    params.sm_dyn = false;
    params.reference_image_multiple = [];
    params.reference_information_extracted_multiple = [];
  } else {
    // NAI4/4.5/V5: v4 caption structure; Vibe uses a model-specific cached encoding.
    params.reference_image_multiple_cached = [];
    // flatten(latent)时清空:角色已在正向串的角色段里,再发一遍结构化 Character Prompts
    // 等于把同一个角色喂两遍,模型会当成画面里有两个同样的人。
    const characters =
      naiSupportsCharacterPrompts(nai.model) && !values.flatten ? (values.characters ?? []) : [];
    const captions = characterCaptions(characters);
    // LWB/官方 V5 都发结构化角色数组;只靠 v4_prompt.char_captions 时部分第三方
    // 转发会丢掉角色特征,这是「鬼画符」的主要来源之一。
    params.characterPrompts = characters.map((_, index) => ({
      prompt: captions.positive[index].char_caption,
      uc: captions.negative[index].char_caption,
      center: captions.positive[index].centers[0],
      enabled: true,
    }));
    // V5 官方前端恒为 true;4.5 沿用「有角色指定位置才开」的旧口径。
    const useCoords = nativeV5 ? true : captions.useCoords;
    params.use_coords = useCoords;
    params.v4_prompt = {
      caption: { base_caption: prompt, char_captions: captions.positive },
      use_coords: useCoords,
      use_order: true,
    };
    params.v4_negative_prompt = {
      caption: { base_caption: negative, char_captions: captions.negative },
      legacy_uc: false,
    };
  }

  // V5 的修正字段与采样器无关(官方/LWB 恒发);旧模型只在 ancestral 时发。
  if (nativeV5 || sampler === 'k_euler_ancestral') {
    params.deliberate_euler_ancestral_bug = false;
    params.prefer_brownian = true;
  }
  return params;
}

/** vibe 模型 key:encodings 分组的键(与官方 .naiv4vibe 一致)。 */
export function vibeModelKey(model: string): string {
  if (model.includes('nai-diffusion-5-curated')) return 'v5curated';
  if (model.includes('nai-diffusion-5-full')) return 'v5full';
  if (model.includes('4-5-curated')) return 'v4-5curated';
  if (model.includes('4-5-full')) return 'v4-5full';
  if (model.includes('4-curated')) return 'v4curated';
  if (model.includes('4-full')) return 'v4full';
  if (model.includes('diffusion-3')) return 'v3';
  return 'v4-5full';
}

/** 一次 applyVibes 的结果。 */
export interface VibeApplication {
  /** 实际叠加进 parameters 的 vibe（含配置强度与实际发送强度）。 */
  applied: GenerationVibe[];
  /** 因缺当前模型编码 / 缺原图 / 模型不支持而跳过的 vibe 名（供 toastr）。 */
  skipped: string[];
}

/**
 * 把启用的 vibe 叠加进 parameters。
 * - NAI3:参考原图进 reference_image_multiple(配信息提取度 1 + 强度);
 * - NAI4/4.5:编码数据进 reference_image_multiple_cached(随机 cache key),强度并进
 *   reference_strength_multiple;强度总和超过 1 且开启归一化时按比例压回 1。
 * 返回实际叠加的 vibe(供随图记录)与被跳过的 vibe 名(调用方据以提示)。
 */
export function applyVibes(
  params: JsonObject,
  nai: NaiSettings,
  dataById: ReadonlyMap<string, NaiVibeData>,
): VibeApplication {
  const active = nai.vibes.filter(v => v.enabled);
  if (!active.length) return { applied: [], skipped: [] };
  if (!naiSupportsVibes(nai.model)) return { applied: [], skipped: active.map(vibe => vibe.name) };
  const applied: GenerationVibe[] = [];
  const skipped: string[] = [];
  const strengths = params.reference_strength_multiple as number[];

  if (isNai3(nai.model)) {
    const images = params.reference_image_multiple as string[];
    const infos = params.reference_information_extracted_multiple as number[];
    for (const vibe of active) {
      const data = dataById.get(vibe.id);
      if (!data?.image) {
        skipped.push(vibe.name);
        continue;
      }
      images.push(data.image);
      infos.push(1);
      strengths.push(vibe.strength);
      applied.push(vibeUsage(vibe, vibe.strength));
    }
    return { applied, skipped };
  }

  const cached = params.reference_image_multiple_cached as { cache_secret_key: string; data: string }[];
  const modelKey = vibeModelKey(nai.model);
  const picked: NaiVibe[] = [];
  for (const vibe of active) {
    const enc = dataById.get(vibe.id)?.encodings[modelKey];
    if (!enc?.encoding) {
      skipped.push(vibe.name);
      continue;
    }
    cached.push({ cache_secret_key: randomUuid(), data: enc.encoding });
    picked.push(vibe);
  }
  // 归一化:总强度 > 1 时按比例压回 1(st-chatu8 同口径;4.5 开归一化时官方端也会自动处理)
  const total = picked.reduce((sum, vibe) => sum + vibe.strength, 0);
  const scale = nai.normalizeRefStrength && total > 1 ? 1 / total : 1;
  for (const vibe of picked) {
    const effective = vibe.strength * scale;
    strengths.push(effective);
    applied.push(vibeUsage(vibe, effective));
  }
  return { applied, skipped };
}

/** 造一条 vibe 使用记录：strength = 面板配置值，effectiveStrength = 实际发送值。 */
function vibeUsage(vibe: NaiVibe, effectiveStrength: number): GenerationVibe {
  return {
    id: vibe.id,
    name: vibe.name,
    group: vibe.group,
    strength: vibe.strength,
    effectiveStrength,
  };
}

/* ============ 网络请求 ============ */

async function naiHttpError(resp: Response, label: string): Promise<NaiError> {
  const text = (await resp.text().catch(() => '')).trim();
  let detail = text;
  try {
    const json = JSON.parse(text);
    if (typeof json?.message === 'string') detail = json.message;
  } catch {
    /* 非 JSON 错误体直接用原文 */
  }
  // Retry-After 一并带上:重试器拿它当退避下界(见 NaiError.retryAfterMs)
  const retryAfterMs = parseRetryAfter(resp.headers?.get('Retry-After'));
  switch (resp.status) {
    case 400:
      return new NaiError(`${label}:请求校验失败:${detail.slice(0, 300)}`, resp.status, retryAfterMs);
    case 401:
      return new NaiError(`${label}:API Key 错误或无效`, resp.status, retryAfterMs);
    case 402:
      return new NaiError(`${label}:需要有效订阅(402)`, resp.status, retryAfterMs);
    case 429:
      return new NaiError(
        `${label}:请求过于频繁(429),已自动退避重试;仍失败请调低「同时出图数」或稍后再试`,
        resp.status,
        retryAfterMs,
      );
    default:
      return new NaiError(`${label} (${resp.status}):${detail.slice(0, 300)}`, resp.status, retryAfterMs);
  }
}

/** 测试连接:优先 /user/subscription 验 key;第三方站无此接口(404)时只验证地址可达。 */
export async function testNaiConnection(
  nai: Pick<NaiSettings, 'url' | 'key'>,
  signal?: AbortSignal,
): Promise<{ message: string }> {
  if (!nai.key.trim()) throw new NaiError('请先填写 API Key');
  const resp = await fetch(naiEndpoint(nai.url, 'user/subscription'), {
    headers: { Authorization: `Bearer ${nai.key.trim()}` },
    signal,
  });
  if (resp.status === 404) {
    return { message: '地址可达,但无订阅接口(第三方站);请以实际生图验证' };
  }
  if (!resp.ok) throw await naiHttpError(resp, '连接 NAI 失败');
  const data = (await resp.json().catch(() => null)) as {
    tier?: number;
    active?: boolean;
    subscription?: { tier?: number; active?: boolean; expiresAt?: number };
  } | null;
  const tier = data?.subscription?.tier ?? data?.tier;
  const active = data?.subscription?.active ?? data?.active;
  const tierName = ['Free', 'Tablet', 'Scroll', 'Opus'][Number(tier)] ?? `Tier ${tier}`;
  return {
    message: `连接正常:${tierName}${active === false ? '(订阅未激活)' : ''}`,
  };
}

/** 解 NAI 返回的 zip,取第一张图转 base64。 */
export function unzipNaiImage(buffer: ArrayBuffer | Uint8Array): { base64: string; filename: string } {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
  } catch {
    throw new NaiError('响应不是有效的 zip 包(第三方站可能返回了其他格式)');
  }
  const name = Object.keys(files).find(n => /\.(png|jpe?g|webp)$/i.test(n)) ?? Object.keys(files)[0];
  if (!name) throw new NaiError('zip 包内没有图片文件');
  return { base64: uint8ToBase64(files[name]), filename: name };
}

/** generateNaiImage 的完整产出：图片 + 随图记录的元信息。 */
export interface NaiImageOutput {
  result: ComfyImageResult;
  /** 不在 tag 文本里的那部分配方（画师串 / vibe / 采样参数 / 模型无关字段）。 */
  usage: Pick<GenerationMeta, 'positive' | 'negative' | 'width' | 'height' | 'artist' | 'vibes' | 'params'>;
}

/** 读启用的 vibe 数据(读失败只告警、按缺编码处理),再叠加进 parameters。 */
async function loadAndApplyVibes(params: JsonObject, nai: NaiSettings): Promise<GenerationVibe[]> {
  const activeVibes = naiSupportsVibes(nai.model) ? nai.vibes.filter(vibe => vibe.enabled) : [];
  const loaded = new Map<string, NaiVibeData>();
  for (const vibe of activeVibes) {
    try {
      const data = await loadVibeData(vibe);
      loaded.set(vibe.id, isNai3(nai.model) ? data : { image: '', thumbnail: '', encodings: data.encodings });
    } catch (error) {
      console.warn(`[柏宝绘] 读取 vibe「${vibe.name}」失败:`, error);
    }
  }
  const { applied, skipped } = applyVibes(params, nai, loaded);
  if (skipped.length) {
    const reason = naiSupportsVibes(nai.model) ? '缺当前模型编码' : '当前模型不支持 Vibe Transfer';
    console.warn(`[柏宝绘] 以下 vibe 因${reason}被跳过:`, skipped);
    toastr.warning(`vibe「${skipped.join('、')}」${reason},已跳过`, '柏宝绘');
  }
  return applied;
}

/**
 * 生图。返回图片与本次实际使用的画师串/vibe/采样参数。
 *
 * 429/5xx/网络级失败会自动退避重试(backends/naiRateLimit.ts);配置类错误
 * (key 错、订阅过期、参数非法)立刻抛出,不做无谓重试。onRetry 用于把退避过程
 * 报给卡片显示 —— 否则用户看着「生成中…」一动不动几十秒,只会以为卡死了再点一次。
 */
export async function generateNaiImage(
  nai: NaiSettings,
  values: NaiGenerateValues,
  signal?: AbortSignal,
  opts: { onRetry?: (info: NaiRetryInfo) => void } = {},
): Promise<NaiImageOutput> {
  if (!nai.key.trim()) throw new NaiError('请先填写 NAI API Key');
  if (!values.prompt.trim()) throw new NaiError('正向提示词不能为空');

  // 画师串在发请求时解析一次，快照下来随图落盘：事后配方被删/改名也不丢。
  const artist = naiArtistUsage(nai);
  const params = buildNaiParameters(nai, values);
  const vibes = await loadAndApplyVibes(params, nai);
  // 顶层 input 与随图记录的 positive 用同一次拼装(latent 下即分段串),记下的就是发出去的
  const positive = fullPositivePrompt(nai, values.prompt, values.nl, {
    characters: values.characters,
    flatten: values.flatten,
  });
  const body = {
    input: positive,
    model: nai.model,
    action: 'generate',
    parameters: params,
    use_new_shared_trial: true,
  };
  const result = await requestNaiImage(
    nai,
    body,
    signal,
    opts.onRetry,
    usesNativeV5(nai, values.flatten),
  );
  const usage = {
    positive,
    negative: fullNegativePrompt(nai),
    width: params.width as number,
    height: params.height as number,
    artist,
    vibes,
    params: naiParamsSnapshot(params, nai),
  };
  return { result, usage };
}

/** 采样参数快照：只收标量，不含提示词与 vibe 二进制。 */
function naiParamsSnapshot(params: JsonObject, nai: NaiSettings): GenerationParams {
  return {
    sampler: params.sampler as string,
    steps: params.steps as number,
    cfg: params.scale as number,
    cfgRescale: params.cfg_rescale as number,
    noiseSchedule: params.noise_schedule as string,
    quality: naiQualityTags(nai),
    varietyBoost: nai.varietyBoost,
    normalizeRefStrength: nai.normalizeRefStrength,
  };
}

/* ---- 传输层:V5 msgpack 流 + 旧 JSON/zip 回落 ---- */

/** V5 流每帧 = 4 字节大端长度 + 该长度的 MessagePack 对象。 */
const NAI_STREAM_FRAME_BYTES = 4;
/** 单帧上限与 LWB 一致;超过即视为异常响应,避免坏帧吃掉内存。 */
const NAI_STREAM_MAX_FRAME_BYTES = 64 * 1024 * 1024;
/** 这些状态说明端点根本没有流式接口,退回旧 JSON 端点。 */
const NAI_STREAM_FALLBACK_STATUSES = new Set([404, 405, 415]);

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_MAGIC = [0xff, 0xd8, 0xff] as const;
const GIF_MAGIC = [0x47, 0x49, 0x46] as const;
const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46] as const;

function matchesMagic(bytes: Uint8Array, magic: readonly number[]): boolean {
  return bytes.length >= magic.length && magic.every((value, index) => bytes[index] === value);
}

/** 图片文件头 → 扩展名;请求里固定 image_format: 'png',认不出就按 png 处理。 */
function detectImageFormat(bytes: Uint8Array): string {
  if (matchesMagic(bytes, PNG_MAGIC)) return 'png';
  if (matchesMagic(bytes, JPEG_MAGIC)) return 'jpg';
  if (matchesMagic(bytes, GIF_MAGIC)) return 'gif';
  const isWebp =
    matchesMagic(bytes, RIFF_MAGIC) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50;
  return isWebp ? 'webp' : 'png';
}

function naiImageResult(base64: string, filename: string): ComfyImageResult {
  const format = filename.split('.').pop()?.toLowerCase() || 'png';
  return {
    url: `data:image/${format === 'jpg' ? 'jpeg' : format};base64,${base64}`,
    filename: `nai-${Date.now()}.${format}`,
    format,
    revoke() {},
  };
}

function isMessagePackMap(value: MessagePackValue): value is { [key: string]: MessagePackValue } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array)
  );
}

/** final 事件的 image 可能是二进制,也可能是第三方代理转成的 base64 / data URI。 */
function coerceImageBytes(value: MessagePackValue | undefined): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (typeof value !== 'string' || !value) return null;
  const payload = value
    .replace(/^data:[^,]*,/, '')
    .replace(/\s+/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  try {
    return base64ToUint8(payload);
  } catch {
    return null;
  }
}

/** 解析一个流事件;intermediate 返回 null,final 返回图片,error/未知事件直接抛。 */
function readNaiStreamEvent(event: MessagePackValue): Uint8Array | null {
  if (!isMessagePackMap(event)) throw new NaiError('NAI V5 流事件不是对象');
  const type = typeof event.event_type === 'string' ? event.event_type : '';
  if (type === 'error') {
    const message = typeof event.message === 'string' && event.message ? event.message : 'NAI V5 生成失败';
    throw new NaiError(message);
  }
  if (type === 'intermediate') return null;
  if (type !== 'final') throw new NaiError(`NAI V5 返回了未知事件:${type || '(空)'}`);
  const image = coerceImageBytes(event.image);
  if (!image?.length) throw new NaiError('NAI V5 final 事件没有有效的图片数据');
  return image;
}

/** 把整段响应按帧拆开,返回 final 事件的图片。 */
function decodeNaiStreamImage(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + NAI_STREAM_FRAME_BYTES <= bytes.length) {
    const frameLength = view.getUint32(offset, false);
    offset += NAI_STREAM_FRAME_BYTES;
    if (!frameLength || frameLength > NAI_STREAM_MAX_FRAME_BYTES) {
      throw new NaiError('NAI V5 返回了无效的 MessagePack 帧长度');
    }
    if (offset + frameLength > bytes.length) throw new NaiError('NAI V5 响应在帧结束前被截断');
    const image = readNaiStreamEvent(decodeMessagePack(bytes.subarray(offset, offset + frameLength)));
    offset += frameLength;
    if (image) return image;
  }
  if (offset !== bytes.length) throw new NaiError('NAI V5 响应在帧结束前被截断');
  throw new NaiError('NAI V5 响应结束但没有返回图片');
}

/**
 * V5 原生传输:multipart 的 request 字段装 JSON,响应是 msgpack 流。
 * 端点明确不支持(404/405/415)、返回 HTML 或空体时返回 null,由调用方退回旧链路;
 * 其余错误照常抛,避免把 401/402 误判成「不支持流式」再白打一次旧端点。
 */
async function requestNaiStreamImage(
  nai: NaiSettings,
  body: JsonObject,
  signal: AbortSignal | undefined,
): Promise<ComfyImageResult | null> {
  const form = new FormData();
  form.append('request', new Blob([JSON.stringify(body)], { type: 'application/json' }), 'blob');
  const resp = await fetch(naiImageEndpoint(nai.url, true), {
    method: 'POST',
    headers: { Authorization: `Bearer ${nai.key.trim()}` },
    body: form,
    signal,
  });
  if (NAI_STREAM_FALLBACK_STATUSES.has(resp.status)) return null;
  if (!resp.ok) throw await naiHttpError(resp, 'NAI 生图失败');
  const contentType = resp.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) return null;
  const bytes = new Uint8Array(await resp.arrayBuffer());
  if (!bytes.length) return null;
  // 部分第三方站对 -stream 端点仍回 zip,顺手兼容。
  if (matchesMagic(bytes, ZIP_MAGIC)) {
    const { base64, filename } = unzipNaiImage(bytes);
    return naiImageResult(base64, filename);
  }
  const image = decodeNaiStreamImage(bytes);
  return naiImageResult(uint8ToBase64(image), `nai.${detectImageFormat(image)}`);
}

async function requestNaiLegacyImage(
  nai: NaiSettings,
  body: JsonObject,
  signal: AbortSignal | undefined,
): Promise<ComfyImageResult> {
  const resp = await fetch(naiImageEndpoint(nai.url, false), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${nai.key.trim()}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) throw await naiHttpError(resp, 'NAI 生图失败');
  const { base64, filename } = unzipNaiImage(await resp.arrayBuffer());
  return naiImageResult(base64, filename);
}

/**
 * 发请求 + 解包。只把这一步包进重试:拼参数、读 vibe 数据的活是一次性的,
 * 重跑它们既白费功夫,也会把 vibe 缺编码的 toastr 警告重复弹出来。
 */
function requestNaiImage(
  nai: NaiSettings,
  body: JsonObject,
  signal: AbortSignal | undefined,
  onRetry: ((info: NaiRetryInfo) => void) | undefined,
  nativeV5: boolean,
): Promise<ComfyImageResult> {
  return runNaiWithRetry(
    async () => {
      if (nativeV5) {
        const streamed = await requestNaiStreamImage(nai, body, signal);
        if (streamed) return streamed;
      }
      return requestNaiLegacyImage(nai, body, signal);
    },
    { signal, onRetry },
  );
}

/* ============ vibe 编码与 .naiv4vibe 互通 ============ */

/** 官方 .naiv4vibe 里 encoding 的固定内层 key(与 st-chatu8 同)。 */
export const VIBE_ENCODING_KEY = 'b36a8472fe418d9f80d6bb1c54e3a6e62c62936aa7bf31dae2bcf7e929f6430f';

/**
 * 调 /ai/encode-vibe 把参考图编码成 vibe 数据(base64)。
 * NAI4/4.5 的 vibe 必须经此编码;NAI3 不需要(直接发原图)。
 *
 * 与生图同样带退避重试:这也是一次真实的 NAI 请求,吃 429 时不该只是弹个红条了事。
 * (并发槽由调用方取,见 pages/backend/panels/NaiPanel.vue —— 与卡片同一条纪律。)
 */
export async function encodeVibeImage(
  nai: Pick<NaiSettings, 'url' | 'key'>,
  imageBase64: string,
  model: string,
  infoExtracted = 1,
  signal?: AbortSignal,
  opts: { onRetry?: (info: NaiRetryInfo) => void } = {},
): Promise<string> {
  if (!nai.key.trim()) throw new NaiError('请先填写 NAI API Key');
  return runNaiWithRetry(
    async () => {
      const resp = await fetch(naiEndpoint(nai.url, 'encode-vibe'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${nai.key.trim()}`,
        },
        body: JSON.stringify({ image: imageBase64, information_extracted: infoExtracted, model }),
        signal,
      });
      if (!resp.ok) throw await naiHttpError(resp, 'vibe 编码失败');
      const bytes = new Uint8Array(await resp.arrayBuffer());
      if (bytes.length < 100) {
        throw new NaiError(`vibe 编码数据异常(仅 ${bytes.length} 字节),接口可能返回了错误响应`);
      }
      return uint8ToBase64(bytes);
    },
    { signal, onRetry: opts.onRetry },
  );
}

export interface ImportedVibe {
  name: string;
  image: string;
  thumbnail: string;
  encodings: NaiVibeEncodings;
  strength: number;
}

/** 解析 .naiv4vibe 文件文本(JSON)为 vibe 条目(不含 id,由调用方补)。 */
export function parseNaiv4vibe(text: string): ImportedVibe {
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new NaiError('不是有效的 .naiv4vibe 文件(JSON 解析失败)');
  }
  if (json?.identifier !== 'novelai-vibe-transfer') {
    throw new NaiError('不是 NovelAI vibe 文件(缺少 novelai-vibe-transfer 标识)');
  }
  const encodings: NaiVibeEncodings = {};
  for (const [modelKey, group] of Object.entries(json.encodings ?? {})) {
    const first = Object.values(group as Record<string, any>)[0];
    if (typeof first?.encoding === 'string' && first.encoding) {
      encodings[modelKey] = {
        encoding: first.encoding,
        infoExtracted:
          typeof first.params?.information_extracted === 'number'
            ? first.params.information_extracted
            : 1,
      };
    }
  }
  if (!Object.keys(encodings).length) throw new NaiError('vibe 文件里没有可用的编码数据');
  return {
    name: typeof json.name === 'string' && json.name ? json.name : '导入的 Vibe',
    image: typeof json.image === 'string' ? json.image : '',
    thumbnail: typeof json.thumbnail === 'string' ? json.thumbnail : '',
    encodings,
    strength: clampVibeStrength(json.importInfo?.strength),
  };
}

/** 导出为官方兼容的 .naiv4vibe JSON(全部已编码模型一并带上)。 */
export async function buildNaiv4vibe(vibe: NaiVibe, data: NaiVibeData): Promise<string> {
  const encodings: Record<string, unknown> = {};
  for (const [modelKey, enc] of Object.entries(data.encodings)) {
    encodings[modelKey] = {
      [VIBE_ENCODING_KEY]: {
        encoding: enc.encoding,
        params: { information_extracted: enc.infoExtracted },
      },
    };
  }
  const id = data.image ? await sha256Hex(data.image) : randomUuid();
  return JSON.stringify({
    identifier: 'novelai-vibe-transfer',
    version: 1,
    type: 'image',
    image: data.image,
    id,
    encodings,
    name: vibe.name,
    thumbnail: data.thumbnail,
    createdAt: Date.now(),
    importInfo: {
      model: Object.keys(data.encodings)[0] ?? '',
      information_extracted: 1,
      strength: vibe.strength,
    },
  });
}
