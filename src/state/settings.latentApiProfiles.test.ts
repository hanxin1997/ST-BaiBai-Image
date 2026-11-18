import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Latent 原生 API 配置库的存量迁移与镜像。
 *
 * 关键点:
 * 1. 老配置没有 profiles 键 → 平铺字段折成唯一一套「默认配置」;
 * 2. profiles 恒非空;activeProfileId 悬空回落第一条;
 * 3. 切配置一次性刷新平铺镜像(出图侧仍读镜像);
 * 4. spec/thinking 留空 = 回落设置页全局(本文件只锁存储,回落链在 prompt.ts)。
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

describe('Latent 配置库迁移', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('老配置没有 profiles → 平铺字段折成「默认配置」', async () => {
    const { settings } = await hydrate({
      latentApi: {
        url: 'https://latent.moe',
        key: 'k',
        positivePrefix: 'my prefix',
        negativePrompt: 'my negative',
        steps: 10,
        sampler: 'res_multistep',
        scheduler: 'beta',
        seed: 42,
        naturalLanguage: false,
        orientationLock: 'square',
      },
    });
    expect(settings.latentApi.profiles).toHaveLength(1);
    expect(settings.latentApi.profiles[0].name).toBe('默认配置');
    expect(settings.latentApi.profiles[0].positivePrefix).toBe('my prefix');
    expect(settings.latentApi.profiles[0].negativePrompt).toBe('my negative');
    expect(settings.latentApi.profiles[0].steps).toBe(10);
    expect(settings.latentApi.profiles[0].sampler).toBe('res_multistep');
    expect(settings.latentApi.profiles[0].scheduler).toBe('beta');
    expect(settings.latentApi.profiles[0].seed).toBe(42);
    expect(settings.latentApi.profiles[0].naturalLanguage).toBe(false);
    expect(settings.latentApi.profiles[0].orientationLock).toBe('square');
    expect(settings.latentApi.activeProfileId).toBe(settings.latentApi.profiles[0].id);
  });

  it('profiles 是空数组(脏数据)→ 补一条,不抛', async () => {
    const { settings } = await hydrate({ latentApi: { profiles: [] } });
    expect(settings.latentApi.profiles).toHaveLength(1);
  });

  it('activeProfileId 悬空 → 回落第一条', async () => {
    const { settings } = await hydrate({
      latentApi: {
        profiles: [
          { id: 'lap_a', name: 'A', steps: 8 },
          { id: 'lap_b', name: 'B', steps: 12 },
        ],
        activeProfileId: 'lap_gone',
      },
    });
    expect(settings.latentApi.activeProfileId).toBe('lap_a');
  });

  it('切配置刷新平铺镜像', async () => {
    const { settings, setActiveLatentApiProfile } = await hydrate({
      latentApi: {
        profiles: [
          { id: 'lap_a', name: 'A', positivePrefix: 'pa', steps: 8, sampler: 'euler' },
          { id: 'lap_b', name: 'B', positivePrefix: 'pb', steps: 12, sampler: 'er_sde' },
        ],
        activeProfileId: 'lap_a',
      },
    });
    expect(settings.latentApi.positivePrefix).toBe('pa');
    expect(settings.latentApi.steps).toBe(8);
    setActiveLatentApiProfile('lap_b');
    expect(settings.latentApi.positivePrefix).toBe('pb');
    expect(settings.latentApi.steps).toBe(12);
    expect(settings.latentApi.sampler).toBe('er_sde');
  });

  it('配置的 spec/thinking 留空,预览图路径保留', async () => {
    const { settings } = await hydrate({
      latentApi: {
        profiles: [
          {
            id: 'lap_a',
            name: 'A',
            spec: '',
            thinking: '',
            previewPath: '/user/images/柏宝绘_Latent配置/lap_a.jpg',
          },
        ],
        activeProfileId: 'lap_a',
      },
    });
    expect(settings.latentApi.profiles[0].spec).toBe('');
    expect(settings.latentApi.profiles[0].thinking).toBe('');
    expect(settings.latentApi.profiles[0].previewPath).toBe('/user/images/柏宝绘_Latent配置/lap_a.jpg');
  });

  it('预览图路径是脏数据 → 视为无预览', async () => {
    const { settings } = await hydrate({
      latentApi: {
        profiles: [{ id: 'lap_a', name: 'A', previewPath: 42 }],
        activeProfileId: 'lap_a',
      },
    });
    expect(settings.latentApi.profiles[0].previewPath).toBeUndefined();
  });

  it('latentApiProfileToConn 保留 url/key,其余字段取自配置', async () => {
    const { settings, latentApiProfileToConn } = await hydrate({
      latentApi: {
        url: 'https://latent.moe',
        key: 'k',
        profiles: [{ id: 'lap_a', name: 'A', positivePrefix: 'px', steps: 9, sampler: 'euler' }],
        activeProfileId: 'lap_a',
      },
    });
    const conn = latentApiProfileToConn(settings.latentApi.profiles[0]);
    expect(conn.url).toBe('https://latent.moe');
    expect(conn.key).toBe('k');
    expect(conn.positivePrefix).toBe('px');
    expect(conn.steps).toBe(9);
  });
});
