/**
 * 「一次出图」的共用中段 —— 楼层卡片与公开接口的唯一生成入口。
 *
 * 原本这段活全写在 Card.vue 的 generate() 里,与槽位运行态(beginGen/failGen)、
 * 落盘(saveImageResult)、重水合(hydrateMessage)缠在一起。公开接口要让第三方
 * 「自己决定图显示在哪」,要的恰恰是**掐头去尾的中段**:
 *
 *   前(调用方):登记运行态 / 校验参数
 *   ★ 中(本模块):NAI 系闸门 → 按 backend 分派 → 拿到图
 *   后(调用方):落盘、显示、收尾埋点
 *
 * **闸门不可绕过**,这是本模块存在的首要理由:直接调 backends/nai.ts 的
 * generateNaiImage 会跑在 floor/genQueue.ts 的并发闸门与全局节奏之外,0.2.0 整版的
 * NAI 限流自愈(429 全局冷却、相邻请求最小间隔、退避重试)当场失效。第三方并发调用
 * 是常态,绕过去的症状是用户 NAI 账号吃一串密集 429 —— 而用户只会认为柏宝绘坏了。
 * 故公开接口与卡片共用本函数,闸门在这里包死。nai 与 latent 共用闸门;ImgRouter
 * 与 ComfyUI 不持槽(前者无客户端并发、后者队列在服务端)。
 *
 * 本模块**刻意不碰**:楼层坐标、genState、extra、水合、请求历史埋点。
 * 埋点留给调用方是有意为之:一条历史记录的「成功」判据各家不同——楼层卡片要等
 * saveImageResult 落盘成功才算成,还要把「图拿到了却因任务被取代而丢弃」记成已取消;
 * 本模块只知道请求本身的成败,替调用方下结论会把那两种情形谎报成成功。
 * 故 decideSeed 单独导出:调用方先定种子(埋点需要它)、再把它显式传进来。
 */

import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import { validateSimpleConfig } from '@/backends/comfyTemplates';
import { generateComfyImage, randomSeed, type ComfyImageResult } from '@/backends/comfyui';
import { generateImgRouterImage } from '@/backends/imgRouter';
import { generateNaiImage, naiRandomSeed, naiSupportsCharacterPrompts } from '@/backends/nai';
import type { Orientation } from '@/backends/size';
import { acquireNaiSlot } from '@/floor/genQueue';
import { activeComfyPreset, effectiveComfyConn, settings, type BackendId } from '@/state/settings';

/** 一次生成的输入。与协议层 ImageInsertion 同形,但不含正文位置信息。 */
export interface GenerateInput {
  /** 正向 danbooru 短 tag。 */
  prompt: string;
  /** 自然语言部分(可空)。 */
  nl?: string;
  /** 本画面动态负面(可空)。ComfyUI 走 %negative_prompt%;NAI 的负面取渠道配置,不吃这个。 */
  negative?: string;
  /** NAI 4.5/V5 原生多角色提示;ComfyUI / ImgRouter 不支持(见 charactersApplied)。 */
  characters?: ImageCharacterPrompt[];
  /** 画幅方向;缺省竖屏。具体像素取渠道配置里的横竖尺寸。 */
  size?: Orientation;
  /** 本次种子。由调用方经 decideSeed() 先行确定(埋点要在发请求前拿到它)。 */
  seed: number;
}

/** 生成过程中的进度上报(卡片用它显示排队位置与退避进度)。 */
export interface GenerateProgress {
  /** 已取得闸门槽位、请求即将发出(NAI 系从「排队中」进入「生成中」的时机)。 */
  onStart?: () => void;
  /** ComfyUI 服务端队列里前面还有几个;null = 未知。 */
  onQueue?: (ahead: number | null) => void;
  /** NAI 限流退避进度;传 null 表示已不在退避中。 */
  onRetry?: (retry: { attempt: number; max: number } | null) => void;
}

export interface GenerateOutput {
  result: ComfyImageResult;
  /** 本次实际使用的种子(原样回传,调用方不必自己记)。 */
  seed: number;
  backend: BackendId;
  /**
   * characters 是否真的发给了后端。
   * ComfyUI / ImgRouter **不支持**多角色提示,传了也是静默丢弃 —— 故显式回报,
   * 调用方据此决定要不要提示用户换后端。
   * 不在这里「降级拼进 prompt」:那正是 0.2.3 修掉的重叠躯干问题(一张图里多份完整外貌)。
   */
  charactersApplied: boolean;
}

/** 后端就绪状态。 */
export interface BackendStatus {
  backend: BackendId;
  configured: boolean;
  /** NAI/Latent 为模型名;ComfyUI 为当前工作流预设名;ImgRouter 为模型 id 或 '(渠道默认)'。 */
  model: string;
  /** 当前后端是否支持 characters(NAI/Latent 4.5/V5 为 true,ComfyUI / ImgRouter 恒 false)。 */
  supportsCharacters: boolean;
  /** configured=false 时的人话原因;已就绪为空串。 */
  reason: string;
}

/** nai 与 latent 走同一条 NAI 协议 + 同一道客户端闸门。 */
export function isNaiProtocol(backend: BackendId): boolean {
  return backend === 'nai' || backend === 'latent';
}

function naiConnOf(backend: 'nai' | 'latent') {
  return backend === 'latent' ? settings.latent : settings.nai;
}

function urlKeyReason(url: string, key: string, urlLabel: string, keyLabel: string): string {
  if (!url.trim()) return `未填写 ${urlLabel}`;
  if (!key.trim()) return `未填写 ${keyLabel}`;
  return '';
}

function comfyStatus(): BackendStatus {
  const preset = activeComfyPreset();
  const base = { backend: 'comfyui' as const, model: preset.name, supportsCharacters: false };
  if (!settings.comfyui.url.trim()) {
    return { ...base, configured: false, reason: '未填写 ComfyUI 服务地址' };
  }
  if (preset.mode === 'simple') {
    const invalid = validateSimpleConfig(preset.simple);
    if (invalid) return { ...base, configured: false, reason: invalid };
    return { ...base, configured: true, reason: '' };
  }
  if (!preset.workflow.trim()) {
    return { ...base, configured: false, reason: '当前工作流预设未填写工作流 JSON' };
  }
  return { ...base, configured: true, reason: '' };
}

/**
 * 当前后端能不能出图。**唯一判据**,卡片(configured)与公开接口共用。
 *
 * ComfyUI 要按模式分别校验(custom 要工作流 JSON;simple 要模型/VAE/CLIP 选齐,
 * 与出图组装同一口径 validateSimpleConfig,避免「卡片能点、出图才报错」);
 * NAI / Latent / ImgRouter 要 url + key。
 */
export function backendStatus(): BackendStatus {
  const backend = settings.defaultBackend;

  if (backend === 'nai' || backend === 'latent') {
    const conn = naiConnOf(backend);
    const reason = urlKeyReason(
      conn.url,
      conn.key,
      backend === 'nai' ? 'NAI 服务地址' : 'Latent 服务地址',
      backend === 'nai' ? 'NAI API Key' : 'Latent API Key',
    );
    return {
      backend,
      model: conn.model,
      // 支持与否只看模型,与配没配齐无关:第三方要在出图前就知道该不该传 characters
      supportsCharacters: naiSupportsCharacterPrompts(conn.model),
      configured: !reason,
      reason,
    };
  }

  if (backend === 'imgrouter') {
    const reason = urlKeyReason(
      settings.imgrouter.url,
      settings.imgrouter.key,
      'ImgRouter 服务地址',
      'ImgRouter 访问令牌',
    );
    return {
      backend,
      model: settings.imgrouter.model.trim() || '(渠道默认)',
      supportsCharacters: false,
      configured: !reason,
      reason,
    };
  }

  if (backend === 'comfyui') return comfyStatus();

  // webui 只剩存量类型(设置迁移会把它归一成 comfyui/nai),真出现就是「没选后端」
  return {
    backend,
    configured: false,
    model: '',
    supportsCharacters: false,
    reason: '出图后端未选择,请在柏宝绘「渠道」页选择出图渠道',
  };
}

/**
 * 定本次种子。**必须在发请求前定好**:一是部分采样器节点不接受 -1 自动随机,
 * 二是埋点与落盘(entry.seed)都要记下它,事后「同种子再来一张」才有依据。
 *
 * 口径:显式指定 > ImgRouter 恒 0 > NAI/Latent 面板固定种子(>0) > 随机。
 * ImgRouter 协议没有 seed,记 0 —— 不用 -1:BbiImageEntry.seed 明确不支持该值。
 */
export function decideSeed(backend: BackendId, override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) return Math.floor(override);
  if (backend === 'imgrouter') return 0;
  if (backend === 'nai' || backend === 'latent') {
    const conn = naiConnOf(backend);
    return conn.seed > 0 ? conn.seed : naiRandomSeed();
  }
  return randomSeed();
}

async function dispatchGenerate(
  status: BackendStatus,
  input: GenerateInput,
  signal: AbortSignal | undefined,
  progress: GenerateProgress,
): Promise<ComfyImageResult> {
  const size = input.size ?? 'portrait';
  const characters = input.characters ?? [];
  if (status.backend === 'imgrouter') {
    return generateImgRouterImage(
      settings.imgrouter,
      { prompt: input.prompt, nl: input.nl ?? '', size },
      signal,
    );
  }
  if (status.backend === 'nai' || status.backend === 'latent') {
    return generateNaiImage(
      naiConnOf(status.backend),
      {
        prompt: input.prompt,
        nl: input.nl ?? '',
        characters,
        seed: input.seed,
        size,
        flatten: status.backend === 'latent',
      },
      signal,
      { onRetry: info => progress.onRetry?.({ attempt: info.attempt, max: info.max }) },
    );
  }
  return generateComfyImage(
    effectiveComfyConn(),
    {
      prompt: input.prompt,
      nl: input.nl ?? '',
      negative_prompt: input.negative ?? '',
      seed: input.seed,
      size,
    },
    signal,
    { onQueue: ahead => progress.onQueue?.(ahead) },
  );
}

/**
 * 按当前设置出一张图。**楼层卡片与公开接口的唯一生成路径。**
 *
 * 不负责落盘、不负责显示、不登记运行态、不做埋点 —— 那些是调用方的事。
 * signal 一路透传到 fetch/轮询;取消时抛 AbortError(DOMException)。
 *
 * 闸门纪律(见 floor/genQueue.ts):NAI 系路径必须持槽发请求,release 放在 finally,
 * 漏一格就永久少一格并发。
 */
export async function generateImage(
  input: GenerateInput,
  signal?: AbortSignal,
  progress: GenerateProgress = {},
): Promise<GenerateOutput> {
  const status = backendStatus();
  // 兜底:卡片侧已用 configured 拦在按钮上,公开接口侧也会先报 not_configured。
  // 真漏到这里说明上游判据漂了,宁可明说也别发一个注定 401/404 的请求。
  if (!status.configured) throw new Error(status.reason || '出图后端未配置');

  const characters = input.characters ?? [];
  // 支持与否由后端说了算:ComfyUI / ImgRouter 恒不支持;NAI / Latent 看模型是否 4.5/V5
  const charactersApplied = characters.length > 0 && status.supportsCharacters;

  let release: (() => void) | null = null;
  try {
    if (isNaiProtocol(status.backend)) release = await acquireNaiSlot(signal);
    progress.onStart?.();
    const result = await dispatchGenerate(status, input, signal, progress);
    // 退避文案到此为止:图已拿到,落盘还要一会儿,不该继续显示「稍后重试」
    progress.onRetry?.(null);
    return { result, seed: input.seed, backend: status.backend, charactersApplied };
  } finally {
    release?.();
  }
}
