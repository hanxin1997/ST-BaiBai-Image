import { afterEach, describe, expect, it } from 'vitest';

import { readBookMemory } from '@/autoTag/bookMemory';

function mockApi(api: unknown): void {
  (globalThis as Record<string, unknown>).STBaiBaiBook = api;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).STBaiBaiBook;
});

describe('book memory', () => {
  it('parses roles only: protagonist + important npcs, absent npcs matched against body text', () => {
    mockApi({
      apiVersion: 1,
      getContextAtFloor: ({ floor }: { floor: number }) => ({
        revision: 7,
        floor,
        floorData: { memory: { valid: false } },
        historyBefore: { relativeText: '【昨天·周三】 两人在客栈相遇。', text: '两人在客栈相遇。' },
        snapshotBefore: {
          revision: 7,
          state: { time: '2025/8/13 20:00', location: '归雁客栈二楼', sceneFocus: { situation: '对坐饮酒' } },
          protagonist: {
            gender: '女',
            age: '22',
            identity: '剑士',
            appearance: '黑色长发',
            outfit: '红斗篷',
            condition: '左臂缠着绷带',
          },
          npcs: [
            // 重要角色:常驻全量
            { name: '阿黛尔', title: '归雁客栈掌柜', gender: '女', age: '28', important: true, desc: '银色短发', outfit: '青衫', condition: '脸色苍白', relation: '挚友', location: '归雁客栈二楼' },
            // 不在场但正文提到:按正文发送
            { name: '铁匠老周', title: '铁匠', gender: '男', desc: '络腮胡', outfit: '皮围裙' },
            // 不在场且正文未提到:不发送
            { name: '路人甲', title: '路过商贩', gender: '男' },
          ],
          plans: [{ kind: 'plan', status: 'open', content: '三日后决斗' }],
          items: [],
        },
      }),
    });

    const memory = readBookMemory(3, '铁匠老周推门进来，把一柄剑放在桌上。');
    expect(memory).not.toBeNull();
    expect(memory!.timing).toBe('before_latest');
    const text = memory!.text;
    expect(text).toContain('主角:性别:女；年龄:22；身份:剑士；外貌:黑色长发；着装:红斗篷；状态:左臂缠着绷带');
    expect(text).toContain('阿黛尔(女·28·归雁客栈掌柜) —— 与主角:挚友 〔外貌:银色短发;着装:青衫;状态:脸色苍白;在:归雁客栈二楼〕');
    expect(text).toContain('铁匠老周(男·铁匠) 〔外貌:络腮胡;着装:皮围裙〕');
    expect(text).not.toContain('路人甲');
    // 与画面无关的内容一律不注入
    expect(text).not.toContain('当前时间');
    expect(text).not.toContain('当前地点');
    expect(text).not.toContain('三日后决斗');
    expect(text).not.toContain('历史剧情');
    expect(text).not.toContain('私密简报');
    expect(text).not.toContain('"state"');
    expect(text).not.toContain('"revision"');
  });

  it('uses after_latest snapshot when the floor already has memory', () => {
    mockApi({
      apiVersion: 1,
      getContextAtFloor: () => ({
        revision: 9,
        floor: 5,
        floorData: { memory: { valid: true } },
        historyBefore: { relativeText: '', text: '' },
        snapshotAfter: {
          revision: 9,
          state: { time: '翌日清晨', location: '城外' },
          protagonist: { gender: '男', appearance: '金发', outfit: '铠甲' },
          npcs: [],
        },
      }),
    });

    const memory = readBookMemory(5, '');
    expect(memory!.timing).toBe('after_latest');
    expect(memory!.text).toContain('主角:性别:男；外貌:金发；着装:铠甲');
  });

  it('falls back to getFloor/getSnapshot on older public API', () => {
    mockApi({
      apiVersion: 1,
      getFloor: () => ({ revision: 4, memory: { valid: false } }),
      getSnapshot: () => ({
        revision: 4,
        state: { time: '深夜', location: '地窖' },
        protagonist: { appearance: '红瞳', outfit: '黑衣' },
      }),
    });

    const memory = readBookMemory(2, '');
    expect(memory!.timing).toBe('before_latest');
    expect(memory!.text).toContain('主角:外貌:红瞳；着装:黑衣');
  });

  it('returns null without the book api', () => {
    expect(readBookMemory(0, '')).toBeNull();
  });

  it('returns null when the snapshot has no role info', () => {
    mockApi({
      apiVersion: 1,
      getContextAtFloor: () => ({
        revision: 1,
        floor: 0,
        floorData: { memory: { valid: false } },
        snapshotBefore: { revision: 1, state: { time: 'x' }, protagonist: {}, npcs: [] },
      }),
    });

    expect(readBookMemory(0, '正文')).toBeNull();
  });
});
