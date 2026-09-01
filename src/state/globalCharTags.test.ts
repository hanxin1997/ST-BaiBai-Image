import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 全局角色库(state/globalCharTags.ts)集成测试。
 * 以假 window.SillyTavern.getContext 喂一个内存 extensionSettings/chatMetadata,
 * 验证:CRUD 落盘、历史剥离、合并进派生库、锁定名拦截 AI ops、提升/复制两条迁移路径。
 */

interface FakeCtx {
  extensionSettings: Record<string, unknown>;
  chatMetadata: Record<string, unknown>;
  chat: Array<Record<string, unknown>>;
  saveSettingsDebounced: ReturnType<typeof vi.fn>;
  saveMetadataDebounced: ReturnType<typeof vi.fn>;
  saveChat: ReturnType<typeof vi.fn>;
}

let ctx: FakeCtx;
// 每次 resetModules 后动态重进,保证模块级状态(fingerprint/baseEntries)干净
let charTags: typeof import('@/state/charTags');
let globalTags: typeof import('@/state/globalCharTags');

function makeEntry(name: string, fields: Record<string, string>) {
  return {
    name,
    fields: { ...charTags.emptyCharFields(), ...fields },
    raw: '',
    nl: '',
    source: 'manual' as const,
    desc: '',
    history: [],
  };
}

beforeEach(async () => {
  vi.resetModules();
  ctx = {
    extensionSettings: {},
    chatMetadata: {},
    chat: [],
    saveSettingsDebounced: vi.fn(),
    saveMetadataDebounced: vi.fn(),
    saveChat: vi.fn(() => Promise.resolve()),
  };
  (globalThis as Record<string, unknown>).window = {
    SillyTavern: { getContext: () => ctx },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  };
  charTags = await import('@/state/charTags');
  globalTags = await import('@/state/globalCharTags');
  globalTags.initGlobalCharTags();
  charTags.hydrateCharTags();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  vi.restoreAllMocks();
});

describe('global char tag store', () => {
  it('upsert 落盘 extensionSettings 且剥离 history,并合并进派生库', () => {
    const ok = globalTags.upsertGlobalCharTag({
      ...makeEntry('玩家', { sex: '1boy', hair: 'short black hair' }),
      history: [{ field: 'hair', from: 'a', to: 'b', reason: 'x', floor: 1, at: 1 }],
    });
    expect(ok).toBe(true);
    expect(globalTags.globalCharTagLib.entries).toHaveLength(1);
    expect(globalTags.globalCharTagLib.entries[0].history).toEqual([]);
    // 派生库(本聊天为空时)直接含全局条目
    expect(charTags.charTagLib.entries.map(e => e.name)).toEqual(['玩家']);
    const stored = ctx.extensionSettings['baibai_image_char_global'] as {
      schemaVersion: number;
      entries: Array<{ name: string; history: unknown[] }>;
    };
    expect(stored.schemaVersion).toBe(1);
    expect(stored.entries[0].name).toBe('玩家');
    expect(ctx.saveSettingsDebounced).toHaveBeenCalled();
  });

  it('同名为覆盖更新;oldName 改名;remove 删除', () => {
    globalTags.upsertGlobalCharTag(makeEntry('玩家', { sex: '1boy' }));
    globalTags.upsertGlobalCharTag(makeEntry('玩家', { sex: '1boy', eyes: 'red eyes' }));
    expect(globalTags.globalCharTagLib.entries).toHaveLength(1);
    expect(globalTags.globalCharTagLib.entries[0].fields.eyes).toBe('red eyes');

    globalTags.upsertGlobalCharTag(makeEntry('冒险者', { sex: '1boy' }), '玩家');
    expect(globalTags.globalCharTagLib.entries.map(e => e.name)).toEqual(['冒险者']);

    expect(globalTags.removeGlobalCharTag('冒险者')).toBe(true);
    expect(globalTags.globalCharTagLib.entries).toEqual([]);
    expect(globalTags.removeGlobalCharTag('不存在')).toBe(false);
  });

  it('拒绝空条目(无字段也无整串)', () => {
    expect(globalTags.upsertGlobalCharTag(makeEntry('空', {}))).toBe(false);
    expect(globalTags.globalCharTagLib.entries).toEqual([]);
  });

  it('init 时领养 extensionSettings 里已有的全局库', async () => {
    ctx.extensionSettings['baibai_image_char_global'] = {
      schemaVersion: 1,
      revision: 3,
      entries: [makeEntry('老玩家', { sex: '1girl' })],
    };
    vi.resetModules();
    charTags = await import('@/state/charTags');
    globalTags = await import('@/state/globalCharTags');
    globalTags.initGlobalCharTags();
    charTags.hydrateCharTags();
    expect(globalTags.globalCharTagLib.entries.map(e => e.name)).toEqual(['老玩家']);
    expect(charTags.charTagLib.entries.map(e => e.name)).toEqual(['老玩家']);
  });
});

describe('锁定与合并语义', () => {
  it('全局独有角色被锁定:本聊天 AI 楼层 ops 对它无效', () => {
    globalTags.upsertGlobalCharTag(makeEntry('玩家', { sex: '1boy', hair: 'short black hair' }));
    const dye = charTags.createCharTagSetOp('玩家', 'hair', 'long red hair', '染发')!;
    ctx.chat = [
      {
        name: 'Char',
        is_user: false,
        is_system: false,
        mes: '正文',
        swipe_id: 0,
        extra: { [charTags.BBI_CHAR_EXTRA_KEY]: { v: 1, swipe: 0, ops: [dye] } },
      },
    ];
    charTags.recomputeCharTags();
    expect(charTags.charTagLib.entries[0].fields.hair).toBe('short black hair');
    expect([...charTags.lockedCharTagNames()]).toEqual(['玩家']);
  });

  it('本聊天手动建同名条目 = 覆盖全局并解锁,AI 可照常变更', () => {
    globalTags.upsertGlobalCharTag(makeEntry('玩家', { sex: '1boy', hair: 'short black hair' }));
    charTags.upsertCharTag(makeEntry('玩家', { sex: '1boy', hair: 'long white hair' }));
    // 解锁
    expect(charTags.lockedCharTagNames().size).toBe(0);
    expect(charTags.charTagBaseNames.has('玩家')).toBe(true);
    // 本聊天值优先
    expect(charTags.charTagLib.entries[0].fields.hair).toBe('long white hair');
    // AI 变更生效
    const dye = charTags.createCharTagSetOp('玩家', 'hair', 'long red hair', '染发')!;
    ctx.chat = [
      {
        name: 'Char',
        is_user: false,
        is_system: false,
        mes: '正文',
        swipe_id: 0,
        extra: { [charTags.BBI_CHAR_EXTRA_KEY]: { v: 1, swipe: 0, ops: [dye] } },
      },
    ];
    charTags.recomputeCharTags();
    expect(charTags.charTagLib.entries[0].fields.hair).toBe('long red hair');
    // 全局库本身不被污染
    expect(globalTags.globalCharTagLib.entries[0].fields.hair).toBe('short black hair');
  });
});

describe('提升为全局 / 复制到本聊天', () => {
  it('提升:快照当前生效值(含 AI 变更)进全局,清本聊天副本与楼层 ops', () => {
    charTags.upsertCharTag(makeEntry('小雪', { sex: '1girl', hair: 'long black hair' }));
    const dye = charTags.createCharTagSetOp('小雪', 'hair', 'short red hair', '剪发染发')!;
    ctx.chat = [
      {
        name: 'Char',
        is_user: false,
        is_system: false,
        mes: '正文',
        swipe_id: 0,
        extra: { [charTags.BBI_CHAR_EXTRA_KEY]: { v: 1, swipe: 0, ops: [dye] } },
      },
    ];
    charTags.recomputeCharTags();
    expect(charTags.findCharTag('小雪')?.fields.hair).toBe('short red hair');

    expect(globalTags.promoteCharTagToGlobal('小雪')).toBe(true);
    // 全局拿到的是当前生效值
    expect(globalTags.globalCharTagLib.entries[0].fields.hair).toBe('short red hair');
    // 本聊天基线副本已删、楼层 ops 已清
    expect(charTags.charTagBaseNames.has('小雪')).toBe(false);
    const floorExtra = (ctx.chat[0] as { extra?: Record<string, unknown> }).extra;
    expect(floorExtra?.[charTags.BBI_CHAR_EXTRA_KEY]).toBeUndefined();
    // 此后该名字被锁定
    expect([...charTags.lockedCharTagNames()]).toEqual(['小雪']);
    expect(charTags.charTagLib.entries[0].fields.hair).toBe('short red hair');
  });

  it('复制到本聊天:全局保留,本聊天副本接管且解锁', () => {
    globalTags.upsertGlobalCharTag(makeEntry('玩家', { sex: '1boy' }));
    expect(globalTags.copyGlobalCharTagToChat('玩家')).toBe(true);
    expect(globalTags.globalCharTagLib.entries).toHaveLength(1);
    expect(charTags.charTagBaseNames.has('玩家')).toBe(true);
    expect(charTags.lockedCharTagNames().size).toBe(0);
    expect(charTags.findCharTag('玩家')?.fields.sex).toBe('1boy');
  });
});
