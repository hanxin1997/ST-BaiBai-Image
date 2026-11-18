import { beforeEach, describe, expect, it } from 'vitest';

import { NAI_MIN_INTERVAL_MS, noteNaiRateLimited, naiPacingDelayMs, setNaiMinInterval } from '@/backends/naiRateLimit';
import { acquireNaiSlot, naiSlotBusy, resetNaiGate, setNaiConcurrency } from '@/floor/genQueue';

/**
 * 按接入点分账的闸门与节奏。
 *
 * 锁住三件事:
 * 1. 每个接入点一把闸门,上限互不影响;
 * 2. A 站排队不会占住 B 站的槽;
 * 3. 429 冷却按闸门分账,不串站。
 */
describe('NAI 闸门分账', () => {
  beforeEach(() => {
    resetNaiGate();
    setNaiMinInterval(0);
  });

  it('两个接入点各自独立并发', async () => {
    setNaiConcurrency(2, 'ep_a');
    setNaiConcurrency(1, 'ep_b');

    const a1 = await acquireNaiSlot(undefined, 'ep_a');
    const a2 = await acquireNaiSlot(undefined, 'ep_a');
    expect(naiSlotBusy('ep_a')).toBe(true);

    // b 站上限 1,与 a 站无关
    const b1 = await acquireNaiSlot(undefined, 'ep_b');
    expect(naiSlotBusy('ep_b')).toBe(true);

    let b2Granted = false;
    const b2 = acquireNaiSlot(undefined, 'ep_b').then(release => {
      b2Granted = true;
      return release;
    });
    await Promise.resolve();
    expect(b2Granted).toBe(false);

    b1();
    const b2Release = await b2;
    expect(b2Granted).toBe(true);

    a1();
    a2();
    b2Release();
    expect(naiSlotBusy('ep_a')).toBe(false);
    expect(naiSlotBusy('ep_b')).toBe(false);
  });

  it('调大一个站的上限不影响另一个站', async () => {
    setNaiConcurrency(1, 'ep_a');
    setNaiConcurrency(1, 'ep_b');
    const a = await acquireNaiSlot(undefined, 'ep_a');
    setNaiConcurrency(3, 'ep_a');
    // a 站调大后新请求可进
    const a2 = await acquireNaiSlot(undefined, 'ep_a');
    expect(naiSlotBusy('ep_b')).toBe(false);
    a();
    a2();
  });

  it('429 冷却只冻住出事的那个站', () => {
    setNaiMinInterval(NAI_MIN_INTERVAL_MS);
    noteNaiRateLimited(5000, Date.now(), 'ep_a');
    expect(naiPacingDelayMs(Date.now(), 'ep_a')).toBeGreaterThan(0);
    expect(naiPacingDelayMs(Date.now(), 'ep_b')).toBe(0);
    setNaiMinInterval(0);
  });

  it('resetNaiGate 清空所有闸门', async () => {
    setNaiConcurrency(2, 'ep_a');
    const release = await acquireNaiSlot(undefined, 'ep_a');
    resetNaiGate();
    expect(naiSlotBusy('ep_a')).toBe(false);
    // 复位后旧 release 不会把计数减穿
    release();
    expect(naiSlotBusy('ep_a')).toBe(false);
  });
});
