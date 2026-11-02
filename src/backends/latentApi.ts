import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import type { ComfyImageResult } from '@/backends/comfyui';
import type { Orientation } from '@/backends/size';
import { randomUuid } from '@/randomUuid';
import { getContext } from '@/st/context';
import type { LatentApiSettings } from '@/state/settings';

/**
 * 「Latent 原生 API」出图后端(latent.moe 的 /api/generate,Anima-2.9B-int8-turbo)。
 * 与旧 latent 渠道(NAI 协议,走 backends/nai.ts 的 flatten)无关。
 *
 * 流程(按接口文档,并用临时 Key 实测过一次):
 * 1. POST /api/generate → 202 + 整份任务对象(id、status:"queued"、queuePosition…)
 * 2. GET /api/generate/{id} 轮询,status 依次 queued → running → succeeded;成功时 artworkId 有值
 * 3. GET /api/media/{artworkId}(不带 size)→ PNG 原图;size=preview 是同尺寸有损 webp,不用
 *
 * **一律经酒馆 CORS 转发**(/proxy/<地址>):站点的响应与预检都不带 Access-Control-Allow-Origin,
 * 浏览器直连必被拦。前提是酒馆 config.yaml 里 enableCorsProxy: true。
 */

export class LatentApiError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'LatentApiError';
    this.status = status;
  }
}

/** 接口的提示词长度上限(字符)。 */
export const LATENT_API_PROMPT_LIMIT = 2000;
/** 显示与随图记录用的模型名(接口不让选模型,固定是这一个)。 */
export const LATENT_API_MODEL = 'Anima-2.9B-int8-turbo';
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
/** 仍在跑的任务状态;其余(除 succeeded)一律当失败。 */
const PENDING_STATUSES = new Set(['queued', 'leased', 'running']);
const PROXY_PREFIX = '/proxy/';
/** NAI 专用的角色互动前缀;旧 NAI tag 换到本渠道时去掉,Anima 不认它们。 */
const NAI_INTERACTION_PREFIX = /\b(?:source|target|mutual)#/gi;

/** 任务对象里本模块用得到的字段(实测返回远不止这些)。 */
interface LatentJob {
  id?: string;
  status?: string;
  artworkId?: string | null;
  errorCode?: string | null;
  width?: number;
  height?: number;
  seed?: number;
}

export interface LatentApiGenerateValues {
  prompt: string;
  nl: string;
  characters: ImageCharacterPrompt[];
  seed: number;
  size: Orientation;
}

export interface LatentApiImageOutput {
  result: ComfyImageResult;
  /** 实际发出的整串提示词。 */
  prompt: string;
  /** 任务返回的实际出图尺寸。 */
  width: number;
  height: number;
}

function proxied(conn: Pick<LatentApiSettings, 'url'>, path: string): string {
  return `${PROXY_PREFIX}${conn.url.trim().replace(/\/+$/, '')}${path}`;
}

/** 请求头:Key + 酒馆的 CSRF 令牌(转发路由在酒馆自己的服务器上)。 */
function headers(conn: Pick<LatentApiSettings, 'key'>, extra: Record<string, string> = {}): Record<string, string> {
  const csrf = getContext()?.getRequestHeaders?.()['X-CSRF-Token'];
  return { Authorization: `Bearer ${conn.key.trim()}`, ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...extra };
}

/** 站点报错体是 {"error":"…"};酒馆转发报错不是 JSON。 */
async function readError(resp: Response): Promise<string> {
  const text = (await resp.text().catch(() => '')).trim();
  try {
    const json = JSON.parse(text) as { error?: unknown };
    if (typeof json?.error === 'string') return json.error;
  } catch {
    /* 非 JSON:多半是酒馆转发自己的报错页 */
  }
  return text.slice(0, 200);
}

async function httpError(resp: Response, label: string): Promise<LatentApiError> {
  const detail = await readError(resp);
  if (resp.status === 401) return new LatentApiError(`${label}:API Key 错误或无效`, 401);
  if (resp.status === 429) return new LatentApiError(`${label}:请求过于频繁(429),请稍后再试`, 429);
  return new LatentApiError(`${label} (${resp.status})${detail ? `:${detail}` : ''}`, resp.status);
}

/** 一个角色段:tag 去掉 NAI 专用前缀;旧 tag 带的角色 nl 接在后面(新渠道的协议不再产出它)。 */
function characterSegment(character: ImageCharacterPrompt): string {
  const tag = character.tag.replace(NAI_INTERACTION_PREFIX, '').replace(/\s{2,}/g, ' ').trim();
  return [tag, character.nl.trim()].filter(Boolean).join('. ');
}

/**
 * 打包成 anima寻迹 世界书那套格式:`Scene:<前缀>, <Base>. Char1:<…>. Description:<nl>`。
 * size 不进串,它走 resolution。没有角色就没有 Char 段,没有 nl 就没有 Description 段。
 */
export function latentApiPrompt(conn: Pick<LatentApiSettings, 'positivePrefix'>, values: Pick<LatentApiGenerateValues, 'prompt' | 'nl' | 'characters'>): string {
  const scene = [conn.positivePrefix.trim(), values.prompt.trim()].filter(Boolean).join(', ');
  const segments = [`Scene:${scene}`];
  values.characters.forEach((character, index) => {
    const segment = characterSegment(character);
    if (segment) segments.push(`Char${index + 1}:${segment}`);
  });
  if (values.nl.trim()) segments.push(`Description:${values.nl.trim()}`);
  return segments.map(segment => segment.replace(/[\s.]+$/, '')).join('. ');
}

/** 发请求;网络层失败(酒馆没起、转发没开导致连接被拒)给人话。 */
async function send(url: string, init: RequestInit, label: string): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new LatentApiError(`${label}:请求没有发出去,请确认酒馆正在运行且已开启 enableCorsProxy`);
  }
}

async function queueJob(conn: LatentApiSettings, values: LatentApiGenerateValues, prompt: string, signal?: AbortSignal): Promise<LatentJob> {
  const negative = conn.negativePrompt.trim();
  const body = {
    prompt,
    ...(negative ? { negativePrompt: negative } : {}),
    seed: values.seed,
    resolution: values.size,
    steps: conn.steps,
    sampler: conn.sampler,
    scheduler: conn.scheduler,
  };
  const resp = await send(
    proxied(conn, '/api/generate'),
    {
      method: 'POST',
      // 每次出图一个新的 Idempotency-Key:接口靠它让「同一次请求重发」不重复排队
      headers: headers(conn, { 'Content-Type': 'application/json', 'Idempotency-Key': randomUuid() }),
      body: JSON.stringify(body),
      signal,
    },
    'Latent 排队',
  );
  if (!resp.ok) throw await httpError(resp, 'Latent 排队失败');
  return (await resp.json()) as LatentJob;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

/** 查一次任务。5xx / 网络抖动重试一次:GET 是幂等的,一次抖动不该让整张图作废。 */
async function readJob(conn: LatentApiSettings, id: string, signal?: AbortSignal): Promise<LatentJob> {
  for (let attempt = 0; ; attempt += 1) {
    const resp = await send(proxied(conn, `/api/generate/${encodeURIComponent(id)}`), { headers: headers(conn), signal }, 'Latent 查询');
    if (resp.ok) return (await resp.json()) as LatentJob;
    if (resp.status < 500 || attempt >= 1) throw await httpError(resp, 'Latent 查询任务失败');
    await sleep(POLL_INTERVAL_MS, signal);
  }
}

/** 轮询到终态。取消只停止轮询:已排队的任务在站点上仍会跑完,图落在用户的私人作品里。 */
async function waitForJob(conn: LatentApiSettings, job: LatentJob, signal?: AbortSignal): Promise<LatentJob> {
  const id = job.id;
  if (!id) throw new LatentApiError('Latent 排队成功但没有返回任务 id');
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let current = job;
  while (PENDING_STATUSES.has(current.status ?? '')) {
    if (Date.now() > deadline) throw new LatentApiError('Latent 生成超时(10 分钟),请到站点作品页查看');
    await sleep(POLL_INTERVAL_MS, signal);
    current = await readJob(conn, id, signal);
  }
  if (current.status !== 'succeeded' || !current.artworkId) {
    throw new LatentApiError(`Latent 生成失败:${current.errorCode || current.status || '未知原因'}`);
  }
  return current;
}

/** 取原图:不带 size 参数 = PNG 原图(实测;size=preview 是同尺寸的有损 webp)。 */
async function fetchArtwork(conn: LatentApiSettings, artworkId: string, signal?: AbortSignal): Promise<ComfyImageResult> {
  const resp = await send(proxied(conn, `/api/media/${encodeURIComponent(artworkId)}`), { headers: headers(conn), signal }, 'Latent 取图');
  if (!resp.ok) throw await httpError(resp, 'Latent 取图失败');
  const blob = await resp.blob();
  const format = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const url = URL.createObjectURL(blob);
  return {
    url,
    filename: `latent-${Date.now()}.${format}`,
    format,
    revoke() {
      URL.revokeObjectURL(url);
    },
  };
}

/** 出一张图。超过提示词上限直接报错,不偷偷截断(截掉的往往是 Description 尾巴,画面会悄悄少东西)。 */
export async function generateLatentApiImage(
  conn: LatentApiSettings,
  values: LatentApiGenerateValues,
  signal?: AbortSignal,
): Promise<LatentApiImageOutput> {
  if (!conn.key.trim()) throw new LatentApiError('请先填写 Latent API Key');
  if (!values.prompt.trim()) throw new LatentApiError('正向提示词不能为空');
  const prompt = latentApiPrompt(conn, values);
  if (prompt.length > LATENT_API_PROMPT_LIMIT) {
    throw new LatentApiError(
      `提示词 ${prompt.length} 字,超过 Latent 上限 ${LATENT_API_PROMPT_LIMIT},请在编辑弹窗里删减`,
    );
  }
  const queued = await queueJob(conn, values, prompt, signal);
  const done = await waitForJob(conn, queued, signal);
  const result = await fetchArtwork(conn, done.artworkId as string, signal);
  return { result, prompt, width: done.width ?? 0, height: done.height ?? 0 };
}

/**
 * 测试连接。接口没有验 Key 的端点,实测:带正确 Key 查不存在的任务 → 404 {"error":"not_found"};
 * Key 不对 → 401。404 但体不是站点那个 JSON = 请求没到站点(多半是酒馆没开 enableCorsProxy)。
 */
export async function testLatentApiConnection(
  conn: Pick<LatentApiSettings, 'url' | 'key'>,
  signal?: AbortSignal,
): Promise<{ message: string }> {
  if (!conn.url.trim()) throw new LatentApiError('请先填写地址');
  if (!conn.key.trim()) throw new LatentApiError('请先填写 API Key');
  const probe = '00000000-0000-0000-0000-000000000000';
  const resp = await send(proxied(conn, `/api/generate/${probe}`), { headers: headers(conn), signal }, '测试连接');
  if (resp.status === 401) throw new LatentApiError('API Key 错误或无效', 401);
  const detail = await readError(resp);
  if (resp.status === 404 && detail === 'not_found') return { message: '连接正常,Key 有效' };
  if (resp.status === 404 || resp.status === 403) {
    throw new LatentApiError(
      `请求没有到达 Latent (${resp.status})。请在酒馆 config.yaml 里设 enableCorsProxy: true 并重启酒馆`,
      resp.status,
    );
  }
  if (resp.ok) return { message: '连接正常' };
  throw new LatentApiError(`测试连接失败 (${resp.status})${detail ? `:${detail}` : ''}`, resp.status);
}
