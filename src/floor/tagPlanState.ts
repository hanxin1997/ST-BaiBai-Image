import { reactive } from 'vue';

/**
 * 「AI 重写提示词」的请求运行态(模块级 store)。
 *
 * 与 genState 同样的理由必须放组件外:卡片生命周期由水合决定,任一兄弟槽位出图都会
 * 触发整楼重水合、把卡片连同组件内 ref 一起销毁;重写请求还在途,重建后的卡片要能
 * 认领回「AI 重写提示词…」并给出取消入口。
 *
 * 【为什么还要存住 promise】
 * 入口在提示词编辑弹窗里(floor/promptEditor.ts),而**关掉弹窗不能中断重写**——
 * 请求属于这个 store,不属于弹窗。用户中途关窗、稍后重开时,弹窗要能 await 回同一个
 * 在途请求、等它收尾后把新提示词读回输入框(「续上」),而不是只看到一个转圈。
 * 故这里存的是 {票据, promise} 而非单纯的布尔。
 *
 * 与 genState 分开存放,不合并:genState 管的是出图请求(queued/generating/error + hash
 * 对账),这里管的是 LLM 提示词请求。两者各有并发/取消语义(取消出图不该误杀重写,
 * 反之亦然),混在一起只会让状态机互相污染。key 与 genState / registry / autoGenerate
 * 保持同构:chatId|messageId|swipeId|seq。
 *
 * 「取消」不在这里做:中止靠 autoTag/runner.ts 的 cancelFloorTags(每楼一把请求锁),
 * 本 store 只负责展示态与收尾认领。
 */

interface TagPlanRecord {
  /** 票据:用于识别「迟到的收尾」——旧任务收尾时不得清掉同 key 的新任务。 */
  token: number;
  /** 在途请求。重开的弹窗 await 它即可接上本次重写的收尾。 */
  promise: Promise<void>;
}

const planning = reactive(new Map<string, TagPlanRecord>());

let nextToken = 1;

export function isTagPlanning(key: string): boolean {
  return planning.has(key);
}

/**
 * 跑一次重写并全程登记运行态。同 key 重复开始以新票据为准(旧任务的收尾不得清掉新任务)。
 *
 * 返回的 promise 与登记的是同一个:调用方可以 await,也可以直接丢掉不管——
 * 请求的生命周期归本 store,不归调用方(关掉弹窗不中断重写靠的就是这一点)。
 */
export function runTagPlan(key: string, run: () => Promise<void>): Promise<void> {
  const token = nextToken++;
  // run() 先跑起来再登记:.finally 的回调是微任务,一定晚于下面这行同步的 set
  const promise = run().finally(() => {
    if (planning.get(key)?.token === token) planning.delete(key);
  });
  planning.set(key, { token, promise });
  return promise;
}

/** 取回在途重写的 promise(无在途则 null)。供重开的弹窗「续上」。 */
export function awaitTagPlan(key: string): Promise<void> | null {
  return planning.get(key)?.promise ?? null;
}

/** 清空全部(切聊天 / 删楼后的全量重建;在途请求由 runner 的 cancelAll 中止)。 */
export function clearAllTagPlans(): void {
  planning.clear();
}
