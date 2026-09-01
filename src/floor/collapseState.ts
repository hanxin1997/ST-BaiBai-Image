import { reactive } from 'vue';

/**
 * 楼层卡片「折叠态」的模块级 store。
 *
 * 为什么必须放在组件外:与 genState.ts 同理——卡片的生命周期由水合决定,swipe、
 * 编辑消息、ST 重渲染楼层都会换锚点、卸载重挂组件,折叠态若放组件 ref 里,
 * 用户折好的图会自己弹开。key 与 genState/registry 同构(chatId|messageId|swipeId|seq),
 * 卡片重建后按 key 认领回自己的折叠态。
 *
 * 为什么不写 message.extra:折叠是「临时遮蔽」性质的 UI 态,不是数据;写 extra 意味着
 * 每次折叠/展开都 saveChat() 落盘一次,代价与语义都不合适。会话内记住即可,
 * 刷新后回落到设置项「楼层图片默认折叠」(settings.ui.autoCollapseImages)。
 *
 * 不主动清理:一个槽位只占一个布尔值,旧聊天/已删槽位的残留可忽略;
 * 且切聊天再切回来时折叠态还在,反而是用户期望的行为。
 */

/** 显式设置过折叠态的槽位;没设过的槽位回落到「默认折叠」设置项。 */
const collapsed = reactive(new Map<string, boolean>());

/** 当前折叠态:手动设置优先,否则用默认值(设置项「楼层图片默认折叠」)。 */
export function isCollapsed(key: string, defaultCollapsed: boolean): boolean {
  return collapsed.get(key) ?? defaultCollapsed;
}

/** 手动设置折叠/展开(覆盖默认值,会话内有效)。 */
export function setCollapsed(key: string, value: boolean): void {
  collapsed.set(key, value);
}
