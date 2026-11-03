/**
 * 出图并发闸门 + NAI 全局节奏。
 *
 * 为什么需要两道闸门:各后端的排队模型不同——
 * - ComfyUI:POST /prompt 拿到 prompt_id 即入**服务端**队列,轮询各查各的 history,
 *   一次性全发出去由 ComfyUI 自己顺序执行。客户端再加队列纯属多余,还白拖慢。
 * - NAI:generate-image 是一次阻塞式 POST,等到图出来才返回,没有队列概念。
 *   并发几个就是几条连接同时压过去,容易吃 429(见 backends/nai.ts 的错误映射)。
 * - Latent 原生 API:POST 只负责入队(202),再轮询任务状态;站点按 Key 限制同时只有
 *   1 个生成任务,多个请求一起发会被拒。故客户端固定串行,一张从入队到原图下载完
 *   才放下一个。
 *
 * NAI 闸门上限用户可调(默认 1),且只管**同时几个**,管不了**多快一个**:release 后
 * 立刻 pump,下一个任务在同一个 tick 就发出去了。被限流时这会打出一串密集失败请求
 * (429 → release → 立刻再来 → 429),恰恰最像滥用。故取到槽后还要等一段全局节奏
 * (相邻请求最小间隔 + 429 冷却),口径收在 backends/naiRateLimit.ts。
 * Latent 原生 API 闸门不需要节奏,固定 1;ComfyUI / ImgRouter 不经过这里。
 */

import {
  abortableDelay,
  naiPacingDelayMs,
  noteNaiRequestStart,
  resetNaiPacing,
} from '@/backends/naiRateLimit';

/** 一道客户端并发闸门的运行态。 */
interface Gate {
  /** 并发上限。 */
  limit: number;
  /** 已占用的槽位数。 */
  running: number;
  /** 等待队列:先进先出,resolve 后拿到执行权。 */
  waiting: Array<() => void>;
}

function createGate(limit: number): Gate {
  return { limit, running: 0, waiting: [] };
}

function pump(gate: Gate): void {
  while (gate.running < gate.limit && gate.waiting.length) {
    const next = gate.waiting.shift();
    if (!next) break;
    gate.running++;
    next();
  }
}

/**
 * 取一个执行槽。返回 release 函数,**必须**在 finally 里调用,否则闸门泄漏。
 * signal 已取消时直接抛 AbortError,不占用槽位;排队期间取消会从队列摘除。
 */
async function takeSlot(gate: Gate, signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) throw signal.reason ?? new DOMException('已取消', 'AbortError');

  if (gate.running < gate.limit) {
    gate.running++;
  } else {
    await new Promise<void>((resolve, reject) => {
      // 排队期间被取消:从队列摘除并抛错,不能让它之后还占一个槽
      const onAbort = () => {
        const index = gate.waiting.indexOf(grant);
        if (index >= 0) gate.waiting.splice(index, 1);
        reject(signal?.reason ?? new DOMException('已取消', 'AbortError'));
      };
      const grant = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      gate.waiting.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  let released = false;
  return () => {
    if (released) return; // 幂等:重复 release 不会把 running 减穿
    released = true;
    gate.running--;
    pump(gate);
  };
}

/* ============ NAI 闸门 ============ */

const naiGate = createGate(1);

/** 设置并发上限(1 起步)。调大时立刻放行等待中的任务。 */
export function setNaiConcurrency(value: number): void {
  naiGate.limit = Math.max(1, Math.floor(value) || 1);
  pump(naiGate);
}

/**
 * 取得一个 NAI 执行槽。返回 release 函数,**必须**在 finally 里调用,否则闸门泄漏。
 * signal 已取消时直接抛 AbortError,不占用槽位。
 *
 * 返回前还会等完全局节奏(最小间隔 + 429 冷却),故调用方拿到 release 时即可立刻发请求。
 */
export async function acquireNaiSlot(signal?: AbortSignal): Promise<() => void> {
  const release = await takeSlot(naiGate, signal);

  // 节奏等待**持槽进行**,这是关键:若放在取槽之前,上限内的 N 个任务会一起等完同一段
  // 再一起发,节流形同虚设。持槽等待才能让第 N 个真正排在第 N-1 个之后。
  // 循环而非单次:等待期间别的槽位可能吃到 429 把冷却又推后了,醒来得重新问一次。
  try {
    for (let wait = naiPacingDelayMs(); wait > 0; wait = naiPacingDelayMs()) {
      await abortableDelay(wait, signal);
    }
  } catch (error) {
    // 等待期间被取消:必须把槽还回去。漏一格就永久少一格并发,漏满就再也发不出请求。
    release();
    throw error;
  }
  noteNaiRequestStart();

  return release;
}

/** 当前是否需要排队(用于卡片显示「排队中」而非「生成中」)。 */
export function naiSlotBusy(): boolean {
  return naiGate.running >= naiGate.limit;
}

/** 测试用:复位闸门与全局节奏。放行(而非丢弃)等待者,避免遗留 promise 永挂。 */
export function resetNaiGate(): void {
  naiGate.limit = 1;
  naiGate.running = 0;
  resetNaiPacing();
  const pending = naiGate.waiting.splice(0, naiGate.waiting.length);
  for (const grant of pending) grant();
}

/* ============ Latent 原生 API 闸门 ============ */

/**
 * Latent 原生 API 站点按 Key 限制同时只有 1 个生成任务。请求是「POST 入队 + 轮询」协议,
 * 多个请求一起打过去会被拒,故客户端固定串行:一张从入队到原图下载完才放下一个。
 * 与 NAI 闸门分开:并发上限不该跟着 NAI 的设置走,也不需要 NAI 的 429 冷却与最小间隔。
 */
const LATENT_API_CONCURRENCY = 1;
const latentApiGate = createGate(LATENT_API_CONCURRENCY);

/** 取得一个 Latent 原生 API 执行槽。返回 release 函数,**必须**在 finally 里调用。 */
export function acquireLatentApiSlot(signal?: AbortSignal): Promise<() => void> {
  return takeSlot(latentApiGate, signal);
}
