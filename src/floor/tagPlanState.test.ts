import { beforeEach, describe, expect, it } from 'vitest';

import { awaitTagPlan, clearAllTagPlans, isTagPlanning, runTagPlan } from '@/floor/tagPlanState';

const KEY = 'c|1|0|0';

/** 手动控制收尾时机的 deferred(不用计时器,避免测试靠睡眠) */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('tagPlanState', () => {
  beforeEach(() => {
    clearAllTagPlans();
  });

  it('跑起来即处于重写中,收尾后清除', async () => {
    const gate = deferred();
    const task = runTagPlan(KEY, () => gate.promise);
    expect(isTagPlanning(KEY)).toBe(true);
    gate.resolve();
    await task;
    expect(isTagPlanning(KEY)).toBe(false);
  });

  it('旧任务的收尾不得清掉新任务的记录', async () => {
    const first = deferred();
    const second = deferred();
    const firstTask = runTagPlan(KEY, () => first.promise);
    const secondTask = runTagPlan(KEY, () => second.promise);
    first.resolve();
    await firstTask;
    // 先开的那个收尾了,但 key 上现在是后开的那个,展示态必须还亮着
    expect(isTagPlanning(KEY)).toBe(true);
    second.resolve();
    await secondTask;
    expect(isTagPlanning(KEY)).toBe(false);
  });

  /**
   * 弹窗「续上」的命门:关掉弹窗不中断重写,重开时要能 await 回同一个在途请求。
   * 若这里返回的不是同一个 promise,重开的弹窗就只会干转圈、等不到收尾。
   */
  it('awaitTagPlan 取回的是同一个在途 promise', async () => {
    const gate = deferred();
    const task = runTagPlan(KEY, () => gate.promise);
    const rejoined = awaitTagPlan(KEY);
    expect(rejoined).toBe(task);
    gate.resolve();
    await task;
    expect(awaitTagPlan(KEY)).toBeNull();
  });

  it('无在途任务时 awaitTagPlan 返回 null', () => {
    expect(awaitTagPlan(KEY)).toBeNull();
  });

  /** 请求失败也必须摘掉运行态,否则那一槽会永远卡在「重写中」再也点不动。 */
  it('run 抛错时照样清除运行态,并把错误抛给调用方', async () => {
    const gate = deferred();
    const task = runTagPlan(KEY, () => gate.promise);
    gate.reject(new Error('boom'));
    await expect(task).rejects.toThrow('boom');
    expect(isTagPlanning(KEY)).toBe(false);
  });

  it('clearAllTagPlans 清空全部槽位', () => {
    runTagPlan(KEY, () => deferred().promise);
    runTagPlan('c|2|0|0', () => deferred().promise);
    clearAllTagPlans();
    expect(isTagPlanning(KEY)).toBe(false);
    expect(isTagPlanning('c|2|0|0')).toBe(false);
  });
});
