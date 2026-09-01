import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 思维链由三后端共用一份拆成 comfy / nai / naiV5 三份。
 *
 * 存量用户的自定义 thinking 一律是照 ComfyUI 形态写的(单串 tag + 邻接绑定),
 * 只迁进同形态的 comfyThinking 与 naiThinking;naiV5Thinking 必须留空回落新默认——
 * 把 ComfyUI 口径灌进 V5 等于把「思维链要求它做规范明令禁止的事」这个 bug 固化下来。
 */
const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

async function hydrateWithAutoTag(autoTag: Record<string, unknown> | undefined) {
  mocks.context = {
    extensionSettings: { baibai_image: autoTag === undefined ? {} : { autoTag } },
    saveSettingsDebounced: vi.fn(),
  };
  const { hydrateSettings, settings } = await import('@/state/settings');
  await hydrateSettings();
  return settings.autoTag;
}

describe('思维链按后端拆分的设置迁移', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('旧的单份 thinking 迁进 comfy 与 nai,V5 留空', async () => {
    const autoTag = await hydrateWithAutoTag({
      prompts: { thinking: '我改过的清单' },
    });
    expect(autoTag.prompts.comfyThinking).toBe('我改过的清单');
    expect(autoTag.prompts.naiThinking).toBe('我改过的清单');
    expect(autoTag.prompts.naiV5Thinking).toBe('');
  });

  it('新装三份都为空(回落各自内置默认)', async () => {
    const autoTag = await hydrateWithAutoTag(undefined);
    expect(autoTag.prompts.comfyThinking).toBe('');
    expect(autoTag.prompts.naiThinking).toBe('');
    expect(autoTag.prompts.naiV5Thinking).toBe('');
  });

  it('已按新字段存过的值不被旧 thinking 覆盖', async () => {
    const autoTag = await hydrateWithAutoTag({
      prompts: {
        thinking: '旧的',
        comfyThinking: '新的 comfy',
        naiThinking: '新的 nai',
        naiV5Thinking: '新的 V5',
      },
    });
    expect(autoTag.prompts.comfyThinking).toBe('新的 comfy');
    expect(autoTag.prompts.naiThinking).toBe('新的 nai');
    expect(autoTag.prompts.naiV5Thinking).toBe('新的 V5');
  });

  it('拆分不动同批次的其余提示词字段', async () => {
    const autoTag = await hydrateWithAutoTag({
      prompts: { jailbreak: '破限', comfySpec: '我的规范', thinking: '我的清单' },
    });
    expect(autoTag.prompts.jailbreak).toBe('破限');
    expect(autoTag.prompts.comfySpec).toBe('我的规范');
    expect(autoTag.prompts.naiSpec).toBe('');
    expect(autoTag.prompts.naiV5Spec).toBe('');
    expect(autoTag.prompts.prefill).toBe('');
  });
});
