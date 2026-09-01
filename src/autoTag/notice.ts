import { settings } from '@/state/settings';

/**
 * 生成 tag 期间的常驻进度提示。
 *
 * 为什么必须有:自动路径(AI 回复落地后自动跑,见 autoTag/runner.ts 的
 * scheduleForGeneratedFloor)在写入成功之前对用户**完全静默**——只有 console 日志。
 * 副 API 慢、或正在重试/切备用渠道时,酒馆里没有任何迹象表明插件在忙,
 * 用户只能干等或以为插件坏了。楼层按钮那颗 spinner 藏在「⋯」展开区里,收起就看不见,
 * 当不了提示。
 *
 * 形态:一条 timeOut=0 的 toastr,内容随重试/切渠道**原地改写**,收尾时撤掉。
 * 多个楼层同时在跑时合并成同一条(每楼一段),不叠一屏 toast。
 *
 * 铁律:提示是辅助设施,它炸了不能带走 tag 生成。所有 toastr 调用一律套 safeToast
 * (与 state/history.ts 的 safeHistory 同一个理由和写法)。
 */

const TOAST_TITLE = '柏宝绘 · 生成生图 tag';
/** 多楼同时在跑时的分隔符。全角竖线在窄屏 toast 里比逗号更容易分辨段落。 */
const SEGMENT_SEP = ' ｜ ';

export interface TagNoticeHandle {
  /** 改写本楼那一段的文字(如「重试 2/2」「已切备用渠道 X」)。 */
  update(detail: string): void;
  /** 撤掉本楼那一段;最后一段撤掉时整条 toast 消失。幂等。 */
  done(): void;
}

interface NoticeSegment {
  floor: number;
  detail: string;
}

/**
 * 键是自增 id 而非楼号:同一楼被重开(手动重新生成撞上自动流程)时,
 * 两段各自独立,后者的 done() 不会把前者的段一起撤掉。
 */
const segments = new Map<number, NoticeSegment>();
let seq = 0;

/** 当前那条 toast 的 jQuery 元素;null = 没在显示。 */
let toastEl: any = null;
/**
 * 本批次是否弹过。用户手动点 × 关掉后,元素脱离文档但本值仍为 true →
 * 后续 update 只改内存不重弹。批次归零时复位,下一批照常弹。
 * (少了这个标记,关掉的提示会在下一次重试时又蹦出来,比不给提示更烦人。)
 */
let shownThisBatch = false;

/** toastr 不可用/抛错时静默降级:提示没了,主流程照跑。 */
function safeToast<T>(task: () => T): T | null {
  try {
    if (typeof toastr === 'undefined') return null;
    return task();
  } catch (error) {
    console.debug('[柏宝绘] 进度提示失败(已忽略)', error);
    return null;
  }
}

const NOOP_HANDLE: TagNoticeHandle = { update: () => {}, done: () => {} };

function composeText(): string {
  return [...segments.values()].map(s => `第 ${s.floor} 楼 · ${s.detail}`).join(SEGMENT_SEP);
}

/** toast 元素还挂在文档上吗?用户点 × 关掉后为 false。 */
function toastAlive(): boolean {
  return Boolean(toastEl?.length) && toastEl[0]?.isConnected === true;
}

function dismiss(): void {
  const el = toastEl;
  toastEl = null;
  shownThisBatch = false;
  if (!el) return;
  safeToast(() => toastr.clear(el));
}

function render(): void {
  if (!segments.size) {
    dismiss();
    return;
  }
  const text = composeText();
  if (toastAlive()) {
    // 原地改文字,不重弹:重弹会走一遍入场动画,看起来像又开了一次新任务
    safeToast(() => toastEl.find('.toast-message').text(text));
    return;
  }
  // 用户手动关掉过 → 不复活,只留内存里的段(下一批次会重新弹)
  if (shownThisBatch) return;
  toastEl =
    safeToast(() =>
      toastr.info(text, TOAST_TITLE, {
        timeOut: 0,
        extendedTimeOut: 0,
        closeButton: true,
        // 点正文不关:提示要活到任务结束,误触关掉就白提示了(× 仍可关)
        tapToDismiss: false,
        // 渠道名是用户输入,直接当 HTML 塞进去是注入面
        escapeHtml: true,
        preventDuplicates: false,
      }),
    ) ?? null;
  shownThisBatch = true;
}

/**
 * 开一段进度提示。
 * notifyProgress 关闭时返回空实现——调用方不必到处判开关,拿到 handle 照常用。
 */
export function beginTagNotice(floor: number, detail: string): TagNoticeHandle {
  if (!settings.autoTag.notifyProgress) return NOOP_HANDLE;
  const id = (seq += 1);
  segments.set(id, { floor, detail });
  render();
  return {
    update(next: string) {
      const segment = segments.get(id);
      // 已 done 的段不复活:收尾后迟到的 update 不该把 toast 又拉起来
      if (!segment) return;
      segment.detail = next;
      render();
    },
    done() {
      if (!segments.delete(id)) return;
      render();
    },
  };
}

/** 撤掉所有段(切聊天 / cancelAll 时用):提示不能留在新聊天上。 */
export function clearTagNotices(): void {
  segments.clear();
  dismiss();
}
