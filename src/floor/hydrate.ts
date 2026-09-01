import { h, render, watch, type VNode } from 'vue';

import Card from '@/floor/Card.vue';
import { clearAutoGenerateFlags } from '@/floor/autoGenerate';
import { cardStyleSheet, cardStyleTextFallback } from '@/floor/cardStyles';
import { setNaiConcurrency } from '@/floor/genQueue';
import { clearAllGen, pruneGenSlots } from '@/floor/genState';
import { SlotRegistry } from '@/floor/registry';
import { historyEntries, latestStaleEntry, promptHash, readStore } from '@/floor/storage';
import { getContext, type STContext } from '@/st/context';
import { BBI_SLOT_SELECTOR, parseImageTagContent, parseImageTags } from '@/st/imageTagRegex';
import { settings } from '@/state/settings';

/**
 * 楼层水合框架（DESIGN-FLOOR-UI.md §5.2 / §6）。
 *
 * 渲染事件触发 → 定位楼层 .mes_text → 锚点列表（DOM 顺序）与
 * parseImageTags(message.mes) 解析出的 tag 列表按序一一配对 → 每个锚点
 * 挂载一张卡片。锚点每次渲染重建，水合每次事件重建，全程幂等。
 *
 * 卡片渲进锚点自己的 **shadow root**（不是锚点本身）：楼层在 ST 的 light DOM 里，
 * ST 全局样式与用户装的美化主题会直接改到卡片上。shadow 边界双向隔离，
 * 与 index.ts 主窗口同构，只是从「一个大 host」变成「每槽位一个小 host」。
 */

export const slotRegistry = new SlotRegistry();

let bound = false;

/**
 * 可继承的排版属性——shadow DOM 不隔离继承，这些会透过 host 从 ST 漏进来。
 * 与 index.ts 的 INHERITED_RESET 同一份职责（那里是主窗口 host，这里是每张卡片 host）；
 * 卡片要**跟随聊天字号**故不钉 font-size，只钉会破坏布局与配色的那些。
 */
const CARD_INHERITED_RESET: Record<string, string> = {
  'font-style': 'normal',
  'font-weight': '400',
  'font-variant': 'normal',
  'letter-spacing': 'normal',
  'word-spacing': 'normal',
  'text-align': 'left',
  'text-transform': 'none',
  'text-indent': '0',
  'text-shadow': 'none',
  'white-space': 'normal',
  'line-height': '1.6',
  direction: 'ltr',
};

/**
 * 备好锚点的 shadow root:挂样式 + 钉死继承属性(幂等)。
 * 锚点每次楼层渲染都是新元素,但 MESSAGE_UPDATED 等事件下也可能复用同一元素,
 * 故 attachShadow 前先查 shadowRoot——重复 attach 会抛。
 */
function ensureShadow(anchor: HTMLElement): ShadowRoot {
  const existing = anchor.shadowRoot;
  if (existing) return existing;

  const shadow = anchor.attachShadow({ mode: 'open' });
  const sheet = cardStyleSheet();
  if (sheet) {
    // 全部卡片共享同一个 CSSStyleSheet 对象:N 张卡零重复、零重复解析
    shadow.adoptedStyleSheets = [sheet];
  } else {
    // 老浏览器兜底:每个 shadow 一份 <style>
    const style = document.createElement('style');
    style.textContent = cardStyleTextFallback();
    shadow.appendChild(style);
  }

  for (const [prop, value] of Object.entries(CARD_INHERITED_RESET)) {
    anchor.style.setProperty(prop, value, 'important');
  }
  return shadow;
}

/** 楼层 .mes_text 元素；楼层不在 DOM（未渲染/群聊懒渲染）时返回 null。 */
function findMesText(messageId: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.mes[mesid="${messageId}"] .mes_text`);
}

function unmountKey(key: string): void {
  const record = slotRegistry.get(key);
  if (!record) return;
  // 显式卸载：锚点容器可能已脱离 DOM（.mes_text 被 ST 整体重写），
  // render(null, container) 对已脱离元素依然安全。
  render(null, record.container);
  slotRegistry.delete(key);
}

/** 卸载并清空全部记录（切聊天 / 删除楼层后全量重建）。 */
function unmountAll(): void {
  for (const key of slotRegistry.keys()) {
    unmountKey(key);
  }
}

/**
 * 水合单条消息的全部槽位。
 *
 * 差分策略(替代旧版「先全卸再全挂」):同 key 且锚点元素没变 → render 同类型组件
 * 做 props patch,组件实例与 DOM(尤其 <img>)原样保留;锚点换了(ST 重渲染重建了
 * .mes_text)或新槽位 → 卸载旧记录重挂;本楼不再需要的记录(tag 变少 / swipe 切换 /
 * 楼层离屏 / 消息删除)卸载。
 *
 * 为什么值得:任一槽位出图成功都会触发本楼重水合,旧实现把所有卡片的 <img> 重建,
 * 每张图都重新发起请求(ST 静态服务 max-age=0,每次都要重验证)——楼层里图越多,
 * 一次出图完成的请求风暴越大。patch 路径下 src 不变则 DOM 不动,零请求。
 */
export function hydrateMessage(messageId: number, ctx: STContext): void {
  const chatId = ctx.getCurrentChatId();
  const message = ctx.chat[messageId];

  /** 本次水合后「应该存在」的槽位:key → {锚点, vnode}。消息没了就留空,下面统一卸载。 */
  const desired = new Map<string, { anchor: HTMLElement; vnode: VNode }>();

  if (message) {
    const tags = parseImageTags(message.mes);
    const swipeId = message.swipe_id ?? 0;
    // 槽位可能整个消失(用户删掉 tag / swipe 到 tag 更少的一版):那些槽位再没有卡片
    // 来对账,运行态记录会永久留存,日后同 key 复现时被新卡片误认领。按 tag 数剪掉越界的。
    pruneGenSlots(chatId ?? '-', messageId, swipeId, tags.length);

    if (tags.length > 0) {
      const mesText = findMesText(messageId);
      // 楼层不在 DOM(未渲染/群聊懒渲染):desired 留空,本楼旧记录被卸载,等下次渲染事件
      if (mesText) {
        const anchors = [...mesText.querySelectorAll<HTMLElement>(BBI_SLOT_SELECTOR)];
        if (anchors.length !== tags.length) {
          console.warn(
            `[柏宝绘] 楼层 #${messageId} 锚点 ${anchors.length} 个 ≠ 生图 tag ${tags.length} 个,按少者配对`,
          );
        }
        const count = Math.min(anchors.length, tags.length);

        for (let seq = 0; seq < count; seq++) {
          const key = slotRegistry.key(chatId, messageId, swipeId, seq);
          // 从 extra 恢复:当前 tag 原文重算 hash 匹配同槽位历史 → ready(可翻页);
          // 无匹配但有旧提示词结果 → stale(DESIGN-FLOOR-UI.md §7.1)。
          const store = readStore(message);
          const hash = promptHash(tags[seq]);
          const history = historyEntries(store, swipeId, hash, seq);
          const entry = history.length ? history[history.length - 1] : null;
          const staleEntry = entry ? null : latestStaleEntry(store, swipeId, hash, seq);
          const content = parseImageTagContent(tags[seq]);
          desired.set(key, {
            anchor: anchors[seq],
            vnode: h(Card, {
              prompt: content.tag,
              nl: content.nl,
              negative: content.negative,
              characters: content.characters,
              size: content.size,
              tag: tags[seq],
              messageId,
              seq,
              swipeId,
              history,
              staleEntry,
              // key 的一部分:与 registry.key 的占位口径一致(chatId 缺失时用 '-')
              chatId: chatId ?? '-',
            }),
          });
        }
      }
    }
  }

  // 卸载本楼不在期望集合内的旧记录(跨 swipeId)
  for (const key of slotRegistry.keysByMessage(chatId, messageId)) {
    if (!desired.has(key)) unmountKey(key);
  }

  // 挂载或差分更新
  for (const [key, { anchor, vnode }] of desired) {
    const existing = slotRegistry.get(key);
    if (existing && existing.container.host === anchor) {
      // 同锚点:render 同类型组件 → props patch,不重挂 DOM、不重跑 onMounted。
      // autoGenerate 标记由 onMounted 消费,但它只出现在「刚写入 tag」的锚点上
      // (写正文必触发 ST 重渲染、锚点必重建),走不到这条分支。
      existing.vnode = vnode;
      render(vnode, existing.container);
    } else {
      // 卡片渲进锚点的 shadow root,与 ST 样式双向隔离;主题跟随设置(默认 st = 融入宿主配色)
      if (existing) unmountKey(key);
      const shadow = ensureShadow(anchor);
      anchor.setAttribute('data-theme', settings.ui.cardTheme || 'st');
      render(vnode, shadow);
      slotRegistry.set(key, { container: shadow, vnode });
    }
  }
}

/** Hydrate currently displayed messages without tearing down cards that still have the same anchors. */
function hydrateVisible(ctx: STContext): void {
  for (let messageId = 0; messageId < ctx.chat.length; messageId++) {
    hydrateMessage(messageId, ctx);
  }
}

/** Full rebuild for chat changes or message deletion. */
export function hydrateAll(ctx: STContext): void {
  unmountAll();
  hydrateVisible(ctx);
}

const LATE_HYDRATION_DELAY = 100;

/**
 * Other ST listeners may still replace .mes_text after an event. Hydrate at the end of the
 * event loop, then check once more; an unchanged anchor only receives a cheap Vue props patch.
 */
function scheduleHydration(
  task: (ctx: STContext) => void,
  lateTask: (ctx: STContext) => void = task,
): void {
  const chatId = getContext()?.getCurrentChatId();
  const run = () => {
    const current = getContext();
    if (!current || current.getCurrentChatId() !== chatId) return;
    task(current);
  };
  setTimeout(run, 0);
  setTimeout(() => {
    const current = getContext();
    if (!current || current.getCurrentChatId() !== chatId) return;
    lateTask(current);
  }, LATE_HYDRATION_DELAY);
}

/**
 * Bind message rendering plus the two recovery events used by ST for generation finalization
 * and loading older history.
 */
export function bindFloorHydration(): boolean {
  if (bound) return true;
  const ctx = getContext();
  if (!ctx?.eventSource) return false;

  bound = true;
  const { eventSource, eventTypes } = ctx;
  const onMessage = (messageId: unknown) => {
    const id = Number(messageId);
    if (!Number.isInteger(id)) return;
    scheduleHydration(current => hydrateMessage(id, current));
  };
  const onVisibleReload = () => scheduleHydration(hydrateVisible);
  const onGenerationEnded = (messageCount: unknown) => {
    const id = Number(messageCount) - 1;
    if (Number.isInteger(id) && id >= 0) scheduleHydration(current => hydrateMessage(id, current));
    else onVisibleReload();
  };
  const onFullReload = () => {
    clearAutoGenerateFlags();
    // A deleted/switched chat no longer owns in-flight generation work.
    clearAllGen();
    scheduleHydration(hydrateAll, hydrateVisible);
  };

  eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onMessage);
  eventSource.on(eventTypes.USER_MESSAGE_RENDERED, onMessage);
  eventSource.on(eventTypes.MESSAGE_UPDATED, onMessage);
  eventSource.on(eventTypes.MESSAGE_SWIPED, onMessage);
  eventSource.on(eventTypes.GENERATION_ENDED, onGenerationEnded);
  if (eventTypes.MORE_MESSAGES_LOADED) {
    eventSource.on(eventTypes.MORE_MESSAGES_LOADED, onVisibleReload);
  }
  eventSource.on(eventTypes.MESSAGE_DELETED, onFullReload);
  eventSource.on(eventTypes.CHAT_CHANGED, onFullReload);

  scheduleHydration(hydrateAll, hydrateVisible);

  // 卡片主题改了 → 就地改各卡片 host 的 data-theme(不必重水合,令牌是 CSS 变量,自动生效)
  watch(
    () => settings.ui.cardTheme,
    theme => {
      for (const record of slotRegistry.all()) {
        const host = record.container.host;
        if (host instanceof HTMLElement) host.setAttribute('data-theme', theme || 'st');
      }
    },
  );
  // NAI 系并发上限 → 闸门(ComfyUI 不限并发,靠服务端队列)。
  // 跟随**当前渠道**而非死盯 settings.nai:nai 与 latent 各有一份 concurrency,
  // 只 watch 前者会让 latent 用户改了数字却不生效(闸门仍按 NAI 那份限流)。
  watch(
    () => (settings.defaultBackend === 'latent' ? settings.latent : settings.nai).concurrency,
    value => setNaiConcurrency(value),
    { immediate: true },
  );
  return true;
}
