/**
 * ImgRouter 出图后端(OpenAI 兼容的 /v1/images/generations)。
 *
 * ImgRouter 是个网关:一个 accessToken 后面挂着若干上游渠道(火山/Gitee/魔搭/HuggingFace),
 * 由它自己决定发给谁。因此本模块只管协议层,不关心上游是哪家。
 *
 * 三个必须记住的协议事实(都在 img-router 源码里核对过):
 * 1. **没有负面提示词,也没有种子**。请求体里塞了也不会被读。故负面词与 seed 在本后端无效,
 *    卡片侧种子记 0(不是 -1,-1 不在 BbiImageEntry.seed 的支持范围内)。
 * 2. **model 不在目标渠道名单里会被静默回落成该渠道默认模型**,不报错。而 /v1/models 返回的是
 *    全渠道并集,所以「选了但没生效」是这里最容易踩的坑,面板必须把 ownedBy 显示出来。
 * 3. **响应固定要 b64_json**。让 img-router 服务端把图床 URL 转成 base64,浏览器就不用去抓
 *    第三方图床(那才是真正躲不过的 CORS)。
 */

import { parseSize, pickSize, type Orientation, type SizePair } from '@/backends/size';
import { getContext } from '@/st/context';
import type { ImgRouterSettings } from '@/state/settings';
import type { ComfyImageResult } from '@/backends/comfyui';

export class ImgRouterError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ImgRouterError';
  }
}

/** 出图/拉模型实际需要的字段(不吃整个 settings,后端层只该看见「这一次用什么」)。 */
export interface ImgRouterRunConn extends SizePair {
  url: string;
  key: string;
  model: string;
  qualityTags: string;
}

export interface ImgRouterGenerateValues {
  prompt: string;
  /** 自然语言部分;渠道「生成自然语言」开关开启时由自动 tag 产出。 */
  nl?: string;
  size: Orientation;
}

export interface ImgRouterModel {
  id: string;
  /** 归属渠道,如 "Gitee,HuggingFace";走 ST 转发时拿不到,为空串。 */
  ownedBy: string;
  /** 友好显示名(目前只有 Krea 系有);走 ST 转发时拿不到,为空串。 */
  display: string;
}

export interface ImgRouterModelList {
  models: ImgRouterModel[];
  /** browser=浏览器直连(带 ownedBy/display);server=ST 服务端转发(只有 id)。 */
  mode: 'browser' | 'server';
}

const MODELS_PATH = 'models';
const GENERATE_PATH = 'images/generations';
/** ST 服务端代理(与副 API 渠道同一条路);用于直连被 CORS 拦掉时兜底拉模型。 */
const ST_STATUS_URL = '/api/backends/chat-completions/status';

/**
 * 拼端点:base 去尾斜杠;纯域名补 /v1;已带路径的原样保留(不破坏自定义路由)。
 * 与 api/client.ts 的 normalizeUrl 同口径,但那份是私有的,且属于 LLM 客户端,不跨模块借用。
 */
export function imgRouterEndpoint(url: string, path: string): string {
  const base = (url ?? '').trim().replace(/\/+$/, '');
  if (!base) throw new ImgRouterError('请先填写 ImgRouter 服务地址');
  const seg = path.replace(/^\/+/, '');
  if (base.endsWith(`/${seg}`)) return base;
  // 纯 host(无路径)时补 /v1;已有路径的按原样接 seg
  const bare = /^https?:\/\/[^/?#]+$/i.test(base);
  return bare ? `${base}/v1/${seg}` : `${base}/${seg}`;
}

/** 归一化 base(去掉端点后缀),供 ST 代理用 —— ST 会自己接 /models 或 /chat/completions。 */
function normalizeBase(url: string): string {
  const base = (url ?? '').trim().replace(/\/+$/, '');
  if (!base) throw new ImgRouterError('请先填写 ImgRouter 服务地址');
  const stripped = base.replace(/\/(images\/generations|models|chat\/completions)$/i, '');
  return /^https?:\/\/[^/?#]+$/i.test(stripped) ? `${stripped}/v1` : stripped;
}

/** 正向提示词:质量词 + tag + 自然语言。ImgRouter 无负面输入,故只拼正向。 */
export function imgRouterFullPrompt(conn: Pick<ImgRouterRunConn, 'qualityTags'>, prompt: string, nl = ''): string {
  return [conn.qualityTags?.trim(), prompt?.trim(), nl?.trim()].filter(Boolean).join(', ');
}

/** base64 魔数判格式;认不出按 png(ImgRouter 的 b64_json 不带 mime)。 */
function detectFormat(base64: string): string {
  if (base64.startsWith('iVBORw0KGgo')) return 'png';
  if (base64.startsWith('/9j/')) return 'jpeg';
  if (base64.startsWith('UklGR')) return 'webp';
  if (base64.startsWith('R0lGOD')) return 'gif';
  return 'png';
}

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
}

/** 把 HTTP 失败读成人话。ImgRouter 的错误体是 {error:{message}} 或 {error:"..."}。 */
async function httpError(resp: Response, label: string): Promise<ImgRouterError> {
  const text = await resp.text().catch(() => '');
  let detail = text.slice(0, 300);
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    const err = parsed?.error;
    if (typeof err === 'string') detail = err;
    else if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
      detail = (err as { message: string }).message;
    }
  } catch {
    /* 非 JSON 就用原文 */
  }
  if (resp.status === 401) {
    return new ImgRouterError(`访问令牌无效或未配置:${detail || '(无详情)'}`, 401);
  }
  return new ImgRouterError(`${label} (${resp.status}):${detail || '(无详情)'}`, resp.status);
}

function requireContext() {
  const context = getContext();
  if (!context) throw new ImgRouterError('SillyTavern 上下文不可用');
  return context;
}

/** 浏览器直连拉模型:能拿到完整元数据(ownedBy/display)。 */
async function fetchModelsDirect(conn: Pick<ImgRouterRunConn, 'url' | 'key'>, signal?: AbortSignal): Promise<ImgRouterModel[]> {
  const headers: Record<string, string> = {};
  if (conn.key?.trim()) headers.Authorization = `Bearer ${conn.key.trim()}`;
  const resp = await fetch(imgRouterEndpoint(conn.url, MODELS_PATH), { headers, signal });
  if (!resp.ok) throw await httpError(resp, '拉取模型列表失败');
  const data = (await resp.json()) as { data?: unknown };
  return readModelArray(data?.data);
}

/**
 * ST 服务端转发拉模型:绕开 CORS,代价是只拿得到 id。
 * 未打 CORS 补丁的 ImgRouter(或部署在别处的旧版本)靠这条路。
 */
async function fetchModelsViaServer(
  conn: Pick<ImgRouterRunConn, 'url' | 'key'>,
  signal?: AbortSignal,
): Promise<ImgRouterModel[]> {
  const context = requireContext();
  const resp = await fetch(ST_STATUS_URL, {
    method: 'POST',
    headers: context.getRequestHeaders(),
    body: JSON.stringify({
      chat_completion_source: 'openai',
      reverse_proxy: normalizeBase(conn.url),
      proxy_password: conn.key?.trim() || '',
    }),
    signal,
  });
  if (!resp.ok) throw await httpError(resp, 'ST 转发拉取模型列表失败');
  const data = (await resp.json()) as { data?: unknown; models?: unknown; error?: unknown };
  if (data?.error && !Array.isArray(data?.data)) {
    throw new ImgRouterError('ST 转发拉取模型列表失败');
  }
  return readModelArray(data?.data ?? data?.models);
}

function readModelArray(raw: unknown): ImgRouterModel[] {
  if (!Array.isArray(raw)) return [];
  const out: ImgRouterModel[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item) out.push({ id: item, ownedBy: '', display: '' });
      continue;
    }
    const entry = item as { id?: unknown; owned_by?: unknown; display?: unknown };
    if (typeof entry?.id !== 'string' || !entry.id) continue;
    out.push({
      id: entry.id,
      ownedBy: typeof entry.owned_by === 'string' ? entry.owned_by : '',
      display: typeof entry.display === 'string' ? entry.display : '',
    });
  }
  return out;
}

/**
 * 拉取可用模型。直连优先(拿得到 ownedBy/display),仅网络级失败才回落 ST 转发 ——
 * HTTP 错误是服务端的真实反馈,转发过去结果一样,不该白跑一趟。
 */
export async function fetchImgRouterModels(
  conn: Pick<ImgRouterRunConn, 'url' | 'key'>,
  signal?: AbortSignal,
): Promise<ImgRouterModelList> {
  try {
    return { models: await fetchModelsDirect(conn, signal), mode: 'browser' };
  } catch (error) {
    if (!isNetworkError(error)) throw error;
    return { models: await fetchModelsViaServer(conn, signal), mode: 'server' };
  }
}

/**
 * 测试连接 = 能不能拉到模型列表。
 *
 * 为什么不验 accessToken:/v1/models 压根不校验 token(源码如此),而唯一会校验的接口是
 * 真实生图 —— 为了测连接白烧一次生图额度不值得。故这里只保证「地址可达」,
 * 令牌对不对要等第一次出图才知道。面板已把这点写明。
 */
export async function testImgRouterConnection(
  conn: Pick<ImgRouterRunConn, 'url' | 'key'>,
  signal?: AbortSignal,
): Promise<{ message: string }> {
  const { models, mode } = await fetchImgRouterModels(conn, signal);
  const channel = mode === 'browser' ? '浏览器直连' : 'ST 后端转发';
  return {
    message: `地址可达(${channel}),拿到 ${models.length} 个模型;访问令牌需以实际出图验证`,
  };
}

/** 按方向取尺寸并转成 ImgRouter 要的 ASCII 写法(832x1216);取不到则返回空串=不发该参数。 */
function resolveSize(conn: SizePair, orientation: Orientation): string {
  const text = pickSize(conn, orientation);
  const size = parseSize(text);
  return size ? `${size.width}x${size.height}` : '';
}

/**
 * 生图。返回与 ComfyImageResult 同构的结果(dataURL 形式),楼层卡片/落盘层可直接复用。
 */
export async function generateImgRouterImage(
  conn: ImgRouterRunConn,
  values: ImgRouterGenerateValues,
  signal?: AbortSignal,
): Promise<ComfyImageResult> {
  if (!conn.key?.trim()) throw new ImgRouterError('请先填写 ImgRouter 访问令牌');
  const prompt = imgRouterFullPrompt(conn, values.prompt, values.nl);
  if (!prompt.trim()) throw new ImgRouterError('正向提示词不能为空');

  const body: Record<string, unknown> = {
    prompt,
    response_format: 'b64_json',
    n: 1,
  };
  // 留空 = 不发,由 ImgRouter 按渠道回落默认模型
  if (conn.model?.trim()) body.model = conn.model.trim();
  const size = resolveSize(conn, values.size);
  if (size) body.size = size;

  let resp: Response;
  try {
    resp = await fetch(imgRouterEndpoint(conn.url, GENERATE_PATH), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${conn.key.trim()}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (isNetworkError(error)) {
      throw new ImgRouterError(
        '连不上 ImgRouter,或它返回了缺 CORS 响应头的错误(旧版本在失败时会漏掉该头,' +
          '浏览器会把整条响应连原因一起拦掉)。请检查地址,并到 ImgRouter 日志里看真实报错。',
      );
    }
    throw error;
  }
  if (!resp.ok) throw await httpError(resp, 'ImgRouter 生图失败');

  const data = (await resp.json().catch(() => null)) as { data?: unknown } | null;
  const first = Array.isArray(data?.data) ? (data!.data as unknown[])[0] : null;
  const item = (first ?? null) as { b64_json?: unknown; url?: unknown } | null;

  if (typeof item?.b64_json === 'string' && item.b64_json) {
    const format = detectFormat(item.b64_json);
    return {
      url: `data:image/${format};base64,${item.b64_json}`,
      filename: `imgrouter-${Date.now()}.${format === 'jpeg' ? 'jpg' : format}`,
      format: format === 'jpeg' ? 'jpg' : format,
      revoke() {},
    };
  }

  // 兜底:ImgRouter 自身 base64 转码失败时只给 URL。交落盘层去取(第三方图床未必允许跨域)。
  if (typeof item?.url === 'string' && item.url) {
    const ext = item.url.split('?')[0].split('.').pop()?.toLowerCase();
    const format = ext && /^(png|jpe?g|webp|gif)$/.test(ext) ? ext.replace('jpeg', 'jpg') : 'png';
    return {
      url: item.url,
      filename: `imgrouter-${Date.now()}.${format}`,
      format,
      revoke() {},
    };
  }

  throw new ImgRouterError('ImgRouter 未返回图片数据');
}
