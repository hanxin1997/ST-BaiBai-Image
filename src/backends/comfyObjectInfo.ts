/**
 * 从 ComfyUI 拉取模型/LoRA/采样器列表,供简易模式表单做候选。
 *
 * 通道策略与 generateComfyImage 同口径:浏览器直连优先(一次 GET /object_info 拿全,
 * 含 LoRA 与 CLIP);仅网络级失败(CORS/拒连)回退 ST 后端转发。
 *
 * ST 后端只有 /api/sd/comfy/models|samplers|schedulers|vaes 四个端点(都是服务端
 * 拉 /object_info 再摘字段),**没有 loras/clips 端点**——转发通道下这两组降级为空,
 * 表单退化为手输(datalist 无候选),并在状态行说明原因。
 *
 * 列表有 session 级缓存:object_info 完整响应有几 MB,切换预设/重开面板不该反复拉;
 * 用户加了新模型点「刷新」强制重拉。
 */

import { ComfyUIError } from '@/backends/comfyui';
import { getContext } from '@/st/context';

export interface ComfyModelLists {
  checkpoints: string[];
  unets: string[];
  ggufs: string[];
  vaes: string[];
  clips: string[];
  loras: string[];
  samplers: string[];
  schedulers: string[];
  /** 实际打通的通道:browser=拿到了全量;server=转发,loras/clips 为空。 */
  mode: 'browser' | 'server';
  fetchedAt: number;
}

/** 转发通道拿不到列表时的常见候选(datalist 兜底,仍允许手输)。 */
export const FALLBACK_SAMPLERS = ['euler', 'euler_ancestral', 'dpmpp_2m', 'dpmpp_2m_sde', 'ddim', 'uni_pc'];
export const FALLBACK_SCHEDULERS = ['normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'beta'];

const SERVER_BASE = '/api/sd/comfy';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function endpoint(base: string, path: string): string {
  return `${base.trim().replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function isNetworkError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  return error instanceof TypeError;
}

/** object_info 里取某个节点某输入的候选列表;节点未装/形状不符一律空数组(降级优先)。 */
function optionList(info: JsonObject, nodeClass: string, input: string): string[] {
  const node = info[nodeClass];
  if (!isObject(node) || !isObject(node.input) || !isObject(node.input.required)) return [];
  const entry = node.input.required[input];
  if (!Array.isArray(entry)) return [];
  const options = entry[0];
  if (!Array.isArray(options)) return [];
  return options.filter((item): item is string => typeof item === 'string');
}

/** 浏览器直连的全量解析。clips 取 CLIPLoader 与 DualCLIPLoader 的并集(同文件夹,口径可能差一版)。 */
export function parseObjectInfo(info: JsonObject): Omit<ComfyModelLists, 'mode' | 'fetchedAt'> {
  return {
    checkpoints: optionList(info, 'CheckpointLoaderSimple', 'ckpt_name'),
    unets: optionList(info, 'UNETLoader', 'unet_name'),
    ggufs: optionList(info, 'UnetLoaderGGUF', 'unet_name'),
    vaes: optionList(info, 'VAELoader', 'vae_name'),
    clips: [
      ...new Set([
        ...optionList(info, 'CLIPLoader', 'clip_name'),
        ...optionList(info, 'DualCLIPLoader', 'clip_name1'),
      ]),
    ],
    loras: optionList(info, 'LoraLoader', 'lora_name'),
    samplers: optionList(info, 'KSampler', 'sampler_name'),
    schedulers: optionList(info, 'KSampler', 'scheduler'),
  };
}

/**
 * ST 转发 /models 的条目是 {value: 原始文件名, text: 展示名};
 * UNet/GGUF 靠 text 前缀区分("UNet: xxx"/"GGUF: xxx"),其余是 checkpoint。
 */
function classifyServerModels(data: unknown): Pick<ComfyModelLists, 'checkpoints' | 'unets' | 'ggufs'> {
  const result = { checkpoints: [] as string[], unets: [] as string[], ggufs: [] as string[] };
  if (!Array.isArray(data)) return result;
  for (const item of data) {
    if (!isObject(item) || typeof item.value !== 'string') continue;
    const text = typeof item.text === 'string' ? item.text : '';
    if (text.startsWith('UNet: ')) result.unets.push(item.value);
    else if (text.startsWith('GGUF: ')) result.ggufs.push(item.value);
    else result.checkpoints.push(item.value);
  }
  return result;
}

function stringArray(data: unknown): string[] {
  return Array.isArray(data) ? data.filter((item): item is string => typeof item === 'string') : [];
}

async function responseError(response: Response, label: string): Promise<ComfyUIError> {
  const text = (await response.text().catch(() => '')).trim();
  return new ComfyUIError(`${label} (${response.status})${text ? `：${text.slice(0, 300)}` : ''}`, response.status);
}

async function fetchViaBrowser(url: string, signal?: AbortSignal): Promise<ComfyModelLists> {
  const response = await fetch(endpoint(url, 'object_info'), { signal });
  if (!response.ok) throw await responseError(response, '读取 ComfyUI 模型列表失败');
  const info = (await response.json()) as JsonObject;
  if (!isObject(info)) throw new ComfyUIError('ComfyUI 返回的 object_info 格式异常');
  return { ...parseObjectInfo(info), mode: 'browser', fetchedAt: Date.now() };
}

async function fetchViaServer(url: string, signal?: AbortSignal): Promise<ComfyModelLists> {
  const context = getContext();
  if (!context) throw new ComfyUIError('SillyTavern 上下文不可用');
  const post = async (path: string): Promise<unknown> => {
    const response = await fetch(`${SERVER_BASE}/${path}`, {
      method: 'POST',
      headers: context.getRequestHeaders(),
      body: JSON.stringify({ url: url.trim() }),
      signal,
    });
    if (!response.ok) throw await responseError(response, 'ST 后端读取 ComfyUI 模型列表失败');
    return response.json();
  };
  const [models, samplers, schedulers, vaes] = await Promise.all([
    post('models'),
    post('samplers'),
    post('schedulers'),
    post('vaes'),
  ]);
  return {
    ...classifyServerModels(models),
    vaes: stringArray(vaes),
    clips: [],
    loras: [],
    samplers: stringArray(samplers),
    schedulers: stringArray(schedulers),
    mode: 'server',
    fetchedAt: Date.now(),
  };
}

const cache = new Map<string, ComfyModelLists>();

/** 拉取列表;同 url 命中缓存直接返回,force 强制重拉(「刷新」按钮)。 */
export async function fetchComfyModelLists(
  url: string,
  options?: { force?: boolean; signal?: AbortSignal },
): Promise<ComfyModelLists> {
  const key = url.trim();
  if (!key) throw new ComfyUIError('请先填写 ComfyUI 服务地址');
  if (!options?.force && cache.has(key)) return cache.get(key)!;

  let lists: ComfyModelLists;
  try {
    lists = await fetchViaBrowser(key, options?.signal);
  } catch (error) {
    // 与出图同口径:仅网络级失败回退;HTTP 错误是服务端真实反馈,转发过去结果一样
    if (!isNetworkError(error)) throw error;
    lists = await fetchViaServer(key, options?.signal);
  }
  cache.set(key, lists);
  return lists;
}

/** 测试用:清空缓存。 */
export function clearComfyModelListsCache(): void {
  cache.clear();
}
