import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ComfyUI 拆成三个库(服务器 / 提示词 / 出图方案)后的存量迁移与引用修复。
 *
 * 关键点:
 * 1. 老渠道级 url 必须折成第一台服务器,否则升级后出图地址凭空变成默认值;
 * 2. 设置页里改过的 ComfyUI 规范/思维链必须折成一套用户提示词并被方案引用;
 * 3. servers 恒非空;悬空/错配的引用要修,不能留一个不生效的 id(暗格)。
 */

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

async function hydrate(stored: Record<string, unknown>) {
  mocks.context = {
    extensionSettings: { baibai_image: stored },
    saveSettingsDebounced: vi.fn(),
  };
  const mod = await import('@/state/settings');
  await mod.hydrateSettings();
  return mod;
}

describe('ComfyUI 三库迁移', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('老渠道级 url 折成第一台服务器,方案引用它', async () => {
    const { settings, activeComfyServer } = await hydrate({
      comfyui: { url: 'http://10.0.0.5:8188', workflow: '{"1":{}}' },
    });
    expect(settings.comfyui.servers).toHaveLength(1);
    expect(settings.comfyui.servers[0].url).toBe('http://10.0.0.5:8188');
    expect(settings.comfyui.workflows[0].serverId).toBe(settings.comfyui.servers[0].id);
    expect(activeComfyServer().url).toBe('http://10.0.0.5:8188');
  });

  it('从未配过 → 一台默认本机服务器', async () => {
    const { settings } = await hydrate({});
    expect(settings.comfyui.servers).toHaveLength(1);
    expect(settings.comfyui.servers[0].url).toBe('http://127.0.0.1:8188');
  });

  it('改过的规范/思维链折成一套用户提示词,方案引用它', async () => {
    const { settings } = await hydrate({
      comfyui: { workflows: [{ id: 'wf_a', name: 'A', workflow: '' }], activeWorkflowId: 'wf_a' },
      autoTag: { prompts: { comfySpec: 'MY-SPEC', comfyThinking: '' } },
    });
    expect(settings.comfyui.promptSets).toHaveLength(1);
    const [set] = settings.comfyui.promptSets;
    expect(set.spec).toBe('MY-SPEC');
    expect(set.thinking).toBe('');
    expect(settings.comfyui.workflows[0].promptSetId).toBe(set.id);
  });

  it('没改过规范/思维链 → 不建用户提示词,方案回落内置', async () => {
    const { settings } = await hydrate({
      comfyui: { workflows: [{ id: 'wf_a', name: 'A', workflow: '' }] },
      autoTag: { prompts: { comfySpec: '', comfyThinking: '  ' } },
    });
    expect(settings.comfyui.promptSets).toHaveLength(0);
    expect(settings.comfyui.workflows[0].promptSetId).toBe('builtin_illust');
  });

  it('悬空的 serverId / promptSetId 被修复', async () => {
    const { settings } = await hydrate({
      comfyui: {
        servers: [{ id: 'cs_a', name: 'A', url: 'http://a:8188' }],
        promptSets: [{ id: 'cps_a', name: 'P', spec: 'x', thinking: '' }],
        workflows: [
          { id: 'wf_a', name: 'A', serverId: 'cs_gone', promptSetId: 'cps_gone' },
          { id: 'wf_b', name: 'B', serverId: 'cs_a', promptSetId: 'cps_a' },
        ],
        activeWorkflowId: 'wf_a',
      },
    });
    expect(settings.comfyui.workflows[0].serverId).toBe('cs_a');
    expect(settings.comfyui.workflows[0].promptSetId).toBe('builtin_illust');
    expect(settings.comfyui.workflows[1].promptSetId).toBe('cps_a');
  });

  it('servers 是空数组(脏数据)→ 补一台,不抛', async () => {
    const { settings } = await hydrate({ comfyui: { servers: [], workflows: [] } });
    expect(settings.comfyui.servers).toHaveLength(1);
    expect(settings.comfyui.workflows).toHaveLength(1);
  });

  it('effectiveComfyConn 读方案引用的服务器', async () => {
    const { settings, effectiveComfyConn } = await hydrate({
      comfyui: {
        servers: [
          { id: 'cs_a', name: 'A', url: 'http://a:8188' },
          { id: 'cs_b', name: 'B', url: 'http://b:8188' },
        ],
        workflows: [{ id: 'wf_a', name: 'A', serverId: 'cs_b', workflow: '{"1":{}}' }],
        activeWorkflowId: 'wf_a',
      },
    });
    expect(settings.comfyui.workflows[0].serverId).toBe('cs_b');
    expect(effectiveComfyConn().url).toBe('http://b:8188');
  });
});
