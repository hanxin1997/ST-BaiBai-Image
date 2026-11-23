import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 破限词「导入预设」的存量迁移与归一化:
 * 1. 老配置没有 importedPresets / presetSource → 行为与加功能前完全一致;
 * 2. 坏快照丢弃、条目去重、按上限截断(预设快照动辄 1.6 MB,不设限会撑爆 settings.json);
 * 3. presetSource=imported 但 presetId 悬空 → 落到第一份,别让 UI 空白;
 * 4. 渠道新增的 allowTools/toolsJson 对老渠道是「关」,不发工具。
 */

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

async function hydrate(stored: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  mocks.context = {
    extensionSettings: { baibai_image: stored, ...extra },
    saveSettingsDebounced: vi.fn(),
  };
  const mod = await import('@/state/settings');
  await mod.hydrateSettings();
  return mod;
}

function entry(identifier: string, content = `内容 ${identifier}`) {
  return { identifier, name: identifier, content, enabled: true, inOrder: true, marker: false };
}

describe('导入预设库归一化', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('老配置没有 importedPresets → 空库,来源是 current', async () => {
    const { settings } = await hydrate({});
    expect(settings.autoTag.importedPresets).toEqual([]);
    expect(settings.autoTag.jailbreakSource).toMatchObject({
      mode: 'custom',
      presetSource: 'current',
      presetId: '',
    });
  });

  it('坏快照丢弃,条目按 identifier 去重', async () => {
    const { settings } = await hydrate({
      autoTag: {
        importedPresets: [
          null,
          'junk',
          { id: 'imp_1', name: 'A', entries: [entry('x'), entry('x'), { identifier: '' }] },
          { id: 'imp_2', name: '空', entries: [] },
          { id: 'imp_3', name: '脏', entries: [{ foo: 1 }] },
        ],
      },
    });
    expect(settings.autoTag.importedPresets).toHaveLength(1);
    expect(settings.autoTag.importedPresets?.[0].entries.map(e => e.identifier)).toEqual(['x']);
  });

  it('超过上限的快照被截断', async () => {
    // 常量单独静态取:hydrate 会 resetModules 后重新 import,不能从动态返回值里解构它
    const MAX = 10;
    const { settings } = await hydrate({
      autoTag: {
        importedPresets: Array.from({ length: MAX + 3 }, (_, i) => ({
          id: `imp_${i}`,
          name: `P${i}`,
          entries: [entry('x')],
        })),
      },
    });
    expect(settings.autoTag.importedPresets).toHaveLength(MAX);
  });

  it('presetSource=imported 但 presetId 悬空 → 落到第一份', async () => {
    const { settings } = await hydrate({
      autoTag: {
        jailbreakSource: {
          mode: 'stPreset',
          presetSource: 'imported',
          presetId: 'imp_gone',
          presetEntries: ['jailbreak'],
        },
        importedPresets: [
          { id: 'imp_a', name: 'A', entries: [entry('jailbreak')] },
          { id: 'imp_b', name: 'B', entries: [entry('nsfw')] },
        ],
      },
    });
    expect(settings.autoTag.jailbreakSource?.presetId).toBe('imp_a');
  });

  it('presetSource=current 时不动 presetId(没有引用可修)', async () => {
    const { settings } = await hydrate({
      autoTag: {
        jailbreakSource: { mode: 'stPreset', presetSource: 'current', presetId: '', presetEntries: ['nsfw'] },
        importedPresets: [{ id: 'imp_a', name: 'A', entries: [entry('nsfw')] }],
      },
    });
    expect(settings.autoTag.jailbreakSource?.presetId).toBe('');
    expect(settings.autoTag.jailbreakSource?.presetEntries).toEqual(['nsfw']);
  });
});

describe('渠道工具字段归一化', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('老渠道没有 allowTools/toolsJson → 关 + 空串(行为不变)', async () => {
    const { settings } = await hydrate({
      channels: [{ id: 'ch_old', name: '旧渠道', url: 'https://a.example', key: 'k', model: 'm' }],
    });
    expect(settings.channels[0]).toMatchObject({ allowTools: false, toolsJson: '' });
  });

  it('开了工具但工具定义不是字符串 → 空串', async () => {
    const { settings } = await hydrate({
      channels: [{ id: 'ch_1', name: 'A', url: '', key: '', model: 'm', allowTools: true, toolsJson: 123 }],
    });
    expect(settings.channels[0]).toMatchObject({ allowTools: true, toolsJson: '' });
  });

  it('柏宝书回写共享存储时丢了绘独有字段 → 按 id 从本地镜像补回', async () => {
    // 书侧的 normalizeChannel 逐字段重建对象,不认识的键(思考强度/工具)会被丢掉。
    // 不做补丁的话,在书里点一次「测试渠道」就把这边的配置静默清零。
    const { settings } = await hydrate(
      {
        channels: [
          {
            id: 'ch_1',
            name: 'A',
            url: 'https://a.example',
            key: 'k',
            model: 'm',
            reasoningEffort: 'high',
            allowTools: true,
            toolsJson: '[{"type":"function","function":{"name":"x"}}]',
          },
        ],
      },
      {
        baibai_api_channels: {
          schemaVersion: 1,
          revision: 9,
          channels: [{ id: 'ch_1', name: 'A', url: 'https://a.example', key: 'k', model: 'm' }],
        },
      },
    );
    expect(settings.channels[0]).toMatchObject({
      reasoningEffort: 'high',
      allowTools: true,
      toolsJson: '[{"type":"function","function":{"name":"x"}}]',
    });
  });
});
