import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * NAI 出图方案库的存量迁移与引用修复。
 *
 * 关键点:
 * 1. 老配置没有 plans 键 → 平铺参数折成唯一一套「默认方案」,升级后出图效果不变;
 * 2. plans 恒非空;activePlanId 悬空回落第一条;
 * 3. 接入点/画师串/vibe 三种引用各有各的修复口径;
 * 4. 切方案 = 一次性刷新平铺镜像(面板与旧调用方仍读镜像)。
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

describe('NAI 方案库迁移', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('老配置没有 plans → 平铺字段折成「默认方案」', async () => {
    const { settings } = await hydrate({
      nai: {
        model: 'nai-diffusion-4-5-full',
        sampler: 'k_euler_ancestral',
        steps: 12,
        scale: 6,
        seed: 777,
        activeArtistId: '',
      },
    });
    expect(settings.nai.plans).toHaveLength(1);
    expect(settings.nai.plans[0].name).toBe('默认方案');
    expect(settings.nai.plans[0].model).toBe('nai-diffusion-4-5-full');
    expect(settings.nai.plans[0].sampler).toBe('k_euler_ancestral');
    expect(settings.nai.plans[0].steps).toBe(12);
    expect(settings.nai.plans[0].scale).toBe(6);
    expect(settings.nai.plans[0].seed).toBe(777);
    expect(settings.nai.activePlanId).toBe(settings.nai.plans[0].id);
  });

  it('老配置的 activeArtistId 折进方案 artistId,并镜像回平铺字段', async () => {
    const { settings } = await hydrate({
      nai: {
        artistPresets: [{ id: 'art_a', name: 'A', prompt: 'artist:a' }],
        activeArtistId: 'art_a',
      },
    });
    expect(settings.nai.plans[0].artistId).toBe('art_a');
    expect(settings.nai.activeArtistId).toBe('art_a');
  });

  it('老配置里 enabled 的 vibe 折进方案 vibeIds', async () => {
    const { settings } = await hydrate({
      nai: {
        vibes: [
          { id: 'v1', name: 'V1', enabled: true, strength: 0.6, modelKeys: [], group: '' },
          { id: 'v2', name: 'V2', enabled: false, strength: 0.4, modelKeys: [], group: '' },
        ],
      },
    });
    expect(settings.nai.plans[0].vibeIds).toEqual(['v1']);
  });

  it('plans 是空数组(脏数据)→ 补一条,不抛', async () => {
    const { settings } = await hydrate({ nai: { plans: [] } });
    expect(settings.nai.plans).toHaveLength(1);
  });

  it('引用修复:接入点悬空回落第一台,画师串悬空清空,vibeIds 剔除不存在项', async () => {
    const { settings } = await hydrate({
      nai: {
        endpoints: [
          { id: 'ep_a', name: 'A', url: 'https://a.example', key: 'ka', concurrency: 1 },
          { id: 'ep_b', name: 'B', url: 'https://b.example', key: 'kb', concurrency: 2 },
        ],
        artistPresets: [{ id: 'art_a', name: 'A', prompt: 'artist:a' }],
        vibes: [{ id: 'v1', name: 'V1', enabled: true, strength: 0.6, modelKeys: [], group: '' }],
        plans: [
          {
            id: 'plan_x',
            name: 'X',
            endpointId: 'ep_gone',
            artistId: 'art_gone',
            vibeIds: ['v1', 'v_gone', 'v1'],
          },
        ],
        activePlanId: 'plan_gone',
      },
    });
    const plan = settings.nai.plans[0];
    expect(plan.endpointId).toBe('ep_a');
    expect(plan.artistId).toBe('');
    expect(plan.vibeIds).toEqual(['v1']);
    expect(settings.nai.activePlanId).toBe('plan_x');
  });

  it('切方案刷新平铺镜像(model/sampler/尺寸/画师串)', async () => {
    const { settings, setActiveNaiPlan } = await hydrate({
      nai: {
        endpoints: [{ id: 'ep_a', name: 'A', url: 'https://a.example', key: 'ka', concurrency: 1 }],
        artistPresets: [{ id: 'art_a', name: 'A', prompt: 'artist:a' }],
        plans: [
          { id: 'plan_a', name: 'A', endpointId: 'ep_a', artistId: 'art_a', model: 'nai-diffusion-4-5-full', steps: 20 },
          { id: 'plan_b', name: 'B', endpointId: 'ep_a', artistId: '', model: 'nai-diffusion-5-full', steps: 28 },
        ],
        activePlanId: 'plan_a',
      },
    });
    expect(settings.nai.model).toBe('nai-diffusion-4-5-full');
    setActiveNaiPlan('plan_b');
    expect(settings.nai.model).toBe('nai-diffusion-5-full');
    expect(settings.nai.steps).toBe(28);
    expect(settings.nai.activeArtistId).toBe('');
  });

  it('effectiveNai 解开引用:接入点 url/key、画师串快照、按 vibeIds 过滤', async () => {
    const { settings, effectiveNai } = await hydrate({
      nai: {
        endpoints: [{ id: 'ep_b', name: 'B', url: 'https://b.example', key: 'kb', concurrency: 2 }],
        artistPresets: [{ id: 'art_a', name: 'A', prompt: 'artist:a' }],
        vibes: [
          { id: 'v1', name: 'V1', enabled: true, strength: 0.6, modelKeys: [], group: '' },
          { id: 'v2', name: 'V2', enabled: true, strength: 0.4, modelKeys: [], group: '' },
        ],
        plans: [
          { id: 'plan_a', name: 'A', endpointId: 'ep_b', artistId: 'art_a', vibeIds: ['v2'] },
        ],
        activePlanId: 'plan_a',
      },
    });
    const run = effectiveNai();
    expect(run.endpointId).toBe('ep_b');
    expect(run.url).toBe('https://b.example');
    expect(run.key).toBe('kb');
    expect(run.artist?.prompt).toBe('artist:a');
    expect(run.vibes.map(v => v.id)).toEqual(['v2']);
    expect(settings.nai.activePlanId).toBe('plan_a');
  });

  it('迁移幂等:再次载入不改已有方案', async () => {
    const stored = {
      nai: {
        plans: [{ id: 'plan_a', name: 'A', endpointId: '', artistId: '', model: 'nai-diffusion-5-full' }],
        activePlanId: 'plan_a',
      },
    };
    const first = await hydrate(stored);
    const planId = first.settings.nai.plans[0].id;
    const second = await hydrate(stored);
    expect(second.settings.nai.plans[0].id).toBe(planId);
    expect(second.settings.nai.plans[0].name).toBe('A');
  });
});
