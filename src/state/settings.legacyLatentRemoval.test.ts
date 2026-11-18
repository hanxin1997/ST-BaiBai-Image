import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 旧 latent 渠道移除后的存量迁移。
 *
 * 锁住:defaultBackend='latent' 的用户升级后落到 Latent 原生 API,而不是悄悄回落成 ComfyUI;
 * 老历史里的 backend:'latent' 仍保留只读(本文件只测设置迁移,历史类型不动)。
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

describe('旧 latent 渠道移除', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('defaultBackend=latent → latentapi', async () => {
    const { settings } = await hydrate({ defaultBackend: 'latent' });
    expect(settings.defaultBackend).toBe('latentapi');
  });

  it('defaultBackend=nai/comfyui 不受影响', async () => {
    const { settings } = await hydrate({ defaultBackend: 'nai' });
    expect(settings.defaultBackend).toBe('nai');
  });

  it('存量 settings.latent 段被丢弃,不再出现在设置对象上', async () => {
    const { settings } = await hydrate({
      latent: { url: 'https://latent.example', key: 'old' },
    });
    expect((settings as unknown as Record<string, unknown>).latent).toBeUndefined();
  });

  it('后端名单里没有 latent', async () => {
    const { SELECTABLE_BACKENDS } = await hydrate({});
    expect(SELECTABLE_BACKENDS.some(b => (b.value as string) === 'latent')).toBe(false);
  });
});
