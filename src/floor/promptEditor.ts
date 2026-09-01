import { h, render } from 'vue';

import PromptEditor from '@/floor/PromptEditor.vue';
import { markForAutoGenerate, consumeAutoGenerate } from '@/floor/autoGenerate';
import { hydrateMessage } from '@/floor/hydrate';
import { confirmDialog } from '@/components/confirm';
import { getContext } from '@/st/context';
import {
  parseImageTags,
  replaceImageTagAt,
  serializeImageTag,
  type ImageTagContent,
} from '@/st/imageTagRegex';
import { applyMessageText, type ApplyMessageResult } from '@/st/messageEdit';

/**
 * 命令式打开「编辑提示词」弹窗(供楼层卡片调用)。
 *
 * 挂载位置与 components/confirm.ts、floor/lightbox.ts 同款:插件 host 的 shadow root ——
 * 那里有 dist/index.css 与 --bbi-* 主题变量,挂 document.body 会裸奔无样式。
 * 特意**不**挂进卡片自己的 shadow root:弹窗是 fixed 全屏层,而卡片活在 .mes_text 内部,
 * 那里的层叠上下文与 overflow 会把它裁掉(灯箱同理,见 lightbox.ts)。
 *
 * 【提示词的真源是正文】
 * tag 原文存在 message.mes 里,不在 extra、不在 store。所以「编辑提示词」本质是一次
 * 正文写回:序列化新 tag → 原位替换第 seq 条 → applyMessageText(身份 CAS)→
 * 重水合。新 tag 换出新 promptHash,老图自动落进 stale 桶(卡片已有「旧提示词」角标
 * 与提示行),故「应用」不需要任何额外落地逻辑。
 */

// 与 index.ts 的 HOST_ID 一致
const HOST_ID = 'bbi-app-host';

/** 楼层坐标快照。弹窗活得比卡片长,这些一律开窗时取值,回调里绝不读 props。 */
export interface PromptEditorAt {
  chatId: string;
  messageId: number;
  swipeId: number;
  seq: number;
  /** 开窗时的 tag 原文:写回前用它确认 seq 还指向同一条 tag。 */
  rawTag: string;
}

export interface PromptEditorOptions {
  at: PromptEditorAt;
  /** 解析出的原始内容(弹窗的初值与「有没有真的改」的基准)。 */
  content: ImageTagContent;
  /** 当前提示词下已有几张图。 */
  historyCount: number;
  /** 后端是否已配置好。 */
  configured: boolean;
}

/** 同一时刻只允许一个编辑弹窗,重复调用先关旧的。 */
let closeCurrent: (() => void) | null = null;

/** 离场动画时长,与 base.css 的 .bbi-modal-enter/leave-active(0.15s)对齐。 */
const LEAVE_MS = 160;

/** 补水合的延时,与 hydrate.ts 的 LATE_HYDRATION_DELAY 同一口径。 */
const LATE_HYDRATION_MS = 100;

/** 写回未成功时给用户的说法(exhaustive:新增 ApplyMessageResult 分支时这里会编译报错)。 */
function failureReason(result: Exclude<ApplyMessageResult, 'saved'>): string {
  switch (result) {
    case 'chat-changed':
      return '聊天已切换,提示词未保存';
    case 'floor-changed':
      return '楼层已变化,提示词未保存';
    case 'swipe-changed':
      return '已切换到别的 swipe,提示词未保存';
    case 'build-failed':
      return '正文里的这条 tag 已被改动,请关闭弹窗后重新编辑';
    case 'unavailable':
      return 'SillyTavern 上下文不可用,提示词未保存';
  }
}

/**
 * 写回正文。返回 true 表示已落盘。
 *
 * 失败一律 toast 并返回 false,**弹窗不关** —— 用户可能刚打了几十个 tag,
 * 因为切了个 swipe 就把草稿吞掉是不可接受的。
 */
async function writeBack(
  at: PromptEditorAt,
  content: ImageTagContent,
  regenerate: boolean,
): Promise<boolean> {
  const context = getContext();
  if (!context) {
    toastr.error('SillyTavern 上下文不可用', '柏宝绘');
    return false;
  }
  const message = context.chat?.[at.messageId];
  if (!message) {
    toastr.error('楼层已不存在,提示词未保存', '柏宝绘');
    return false;
  }

  const nextTag = serializeImageTag(content);
  // 标记必须挂在写回**之前**:写回即触发重水合、卡片挂载时消费标记(同 autoTag/runner.ts)。
  // force 模式无条件开跑 —— 用户点的就是「重新生成」,即便这条提示词以前出过图。
  if (regenerate) {
    markForAutoGenerate(at.chatId, at.messageId, at.swipeId, at.seq, 'force');
  }

  let result: Awaited<ReturnType<typeof applyMessageText>>;
  try {
    result = await applyMessageText(
      at.messageId,
      currentText => {
        // 弹窗可能开着好几分钟。身份 CAS 只认聊天/楼层/swipe,**刻意不比对正文内容**
        // (那是与别的改正文插件共存的关键),所以「tag 数变了 / 这条 tag 被别人改了」
        // 拦不住,只能在这里按原文自己核对:seq 指的还是不是同一条。
        if (parseImageTags(currentText)[at.seq] !== at.rawTag) return null;
        return replaceImageTagAt(currentText, at.seq, nextTag);
      },
      at.chatId,
      at.swipeId,
      message,
    );
  } catch (error) {
    // 撤销标记:只取回自己这一枚,不能用 clearAutoGenerateForFloor(会连累同楼兄弟槽位)
    if (regenerate) consumeAutoGenerate(at.chatId, at.messageId, at.swipeId, at.seq);
    toastr.error(error instanceof Error ? error.message : String(error), '柏宝绘');
    return false;
  }

  if (result !== 'saved') {
    if (regenerate) consumeAutoGenerate(at.chatId, at.messageId, at.swipeId, at.seq);
    toastr.warning(failureReason(result), '柏宝绘');
    return false;
  }

  // applyMessageText 内部会触发 MESSAGE_EDITED / MESSAGE_UPDATED,楼层通常已自行重水合;
  // 但 ST 编辑框开着时它走 settleActiveEditor 分支(**不发 MESSAGE_UPDATED**),没人来水合,
  // 故这里自己补。补两次的理由同 hydrate.ts 的 scheduleHydration:别的 ST 监听器可能在这之后
  // 才替换 .mes_text,晚班那次若锚点没变只是一次廉价 props patch(零重建、零重复消费标记)。
  hydrateMessage(at.messageId, context);
  setTimeout(() => {
    const later = getContext();
    if (!later || later.getCurrentChatId() !== at.chatId) return;
    hydrateMessage(at.messageId, later);
  }, LATE_HYDRATION_MS);
  return true;
}

export function openPromptEditor(options: PromptEditorOptions): void {
  const root = document.getElementById(HOST_ID)?.shadowRoot;
  if (!root) return;
  closeCurrent?.();

  const container = document.createElement('div');
  root.appendChild(container);
  let busy = false;
  /** 草稿是否已改动:由组件 emit('dirty') 推上来。 */
  let dirty = false;
  /** 已请求关闭:置上后重渲染一次让组件播离场动画,LEAVE_MS 后真卸载。 */
  let closing = false;
  /** 正在问「放弃修改?」:ConfirmDialog 自己不处理 Esc,而本弹窗的捕获监听还活着,
   *  不挡住的话连按 Esc 会叠出好几个确认框。 */
  let asking = false;

  const close = () => {
    if (closeCurrent !== close) return; // 已被后来者替换,不重复清理
    closeCurrent = null;
    // 先让组件播离场动画(ModalMask 的 Transition 要求容器仍挂着),再真卸载
    closing = true;
    paint();
    setTimeout(() => {
      render(null, container);
      container.remove();
    }, LEAVE_MS);
  };
  closeCurrent = close;

  /** 关窗请求:草稿改过就先问一句,免得手打半天被一下 Esc 吞掉。 */
  const requestClose = () => {
    if (busy || asking || closing) return;
    if (!dirty) {
      close();
      return;
    }
    asking = true;
    void confirmDialog({
      title: '放弃修改',
      text: '提示词的改动还没有应用,关闭后会丢失。',
      confirmText: '放弃',
      cancelText: '继续编辑',
      tone: 'danger',
    }).then(ok => {
      asking = false;
      if (ok) close();
    });
  };

  /**
   * 重渲染(props patch,组件实例与草稿都留着 —— 写回失败时用户不丢输入)。
   *
   * **不用 ref 拿组件实例**:命令式 render 没有父组件,`ref` 的 owner 为 null,
   * 挂载时 Vue 因 parentComponent 护栏静默跳过、卸载时无护栏直接抛
   * "Cannot read properties of null (reading 'refs')",且 ref 从未生效
   * → 拿不到实例 → 关不掉弹窗。状态一律走 props/emit。
   */
  const paint = () => {
    render(
      h(PromptEditor, {
        content: options.content,
        historyCount: options.historyCount,
        configured: options.configured,
        busy,
        closing,
        onDirty: (value: boolean) => {
          dirty = value;
        },
        onApply: (value: ImageTagContent, regenerate: boolean) => {
          if (busy || closing) return;
          busy = true;
          paint();
          void writeBack(options.at, value, regenerate).then(ok => {
            busy = false;
            if (ok) close();
            else paint();
          });
        },
        onClose: requestClose,
      }),
      container,
    );
  };
  paint();
}
