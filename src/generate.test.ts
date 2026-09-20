import { beforeEach, describe, expect, it, vi } from 'vitest';

import { generateComfyImage } from '@/backends/comfyui';
import { generateImgRouterImage } from '@/backends/imgRouter';
import { generateNaiImage } from '@/backends/nai';
import { acquireNaiSlot } from '@/floor/genQueue';
import { backendStatus, decideSeed, generateImage } from '@/generate';
import { settings, type NaiModel } from '@/state/settings';

vi.mock('@/backends/nai', async importOriginal => ({
  ...(await importOriginal<typeof import('@/backends/nai')>()),
  generateNaiImage: vi.fn(),
}));
vi.mock('@/backends/comfyui', async importOriginal => ({
  ...(await importOriginal<typeof import('@/backends/comfyui')>()),
  generateComfyImage: vi.fn(),
}));
vi.mock('@/backends/imgRouter', async importOriginal => ({
  ...(await importOriginal<typeof import('@/backends/imgRouter')>()),
  generateImgRouterImage: vi.fn(),
}));
vi.mock('@/floor/genQueue', () => ({ acquireNaiSlot: vi.fn() }));

function fakeResult() {
  return { url: 'data:image/png;base64,AAAA', filename: 'x.png', format: 'png', revoke: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(acquireNaiSlot).mockResolvedValue(vi.fn());
  vi.mocked(generateNaiImage).mockResolvedValue(fakeResult());
  vi.mocked(generateComfyImage).mockResolvedValue(fakeResult());
  vi.mocked(generateImgRouterImage).mockResolvedValue(fakeResult());
});

/** 把设置调成「NAI 已配齐」。 */
function naiReady(model: NaiModel = 'nai-diffusion-4-5-full'): void {
  settings.defaultBackend = 'nai';
  settings.nai.url = 'https://image.novelai.net';
  settings.nai.key = 'k';
  settings.nai.model = model;
  settings.nai.seed = 0;
}

/** 把设置调成「ComfyUI 自定义工作流已配齐」。 */
function comfyReady(): void {
  settings.defaultBackend = 'comfyui';
  settings.comfyui.url = 'http://127.0.0.1:8188';
  const preset = settings.comfyui.workflows[0];
  settings.comfyui.activeWorkflowId = preset.id;
  preset.mode = 'custom';
  preset.workflow = '{"1":{}}';
}

/** 把设置调成「Latent 已配齐」。 */
function latentReady(model: NaiModel = 'nai-diffusion-4-5-full'): void {
  settings.defaultBackend = 'latent';
  settings.latent.url = 'https://latent.example';
  settings.latent.key = 'k';
  settings.latent.model = model;
  settings.latent.seed = 0;
}

/** 把设置调成「ImgRouter 已配齐」。 */
function imgrouterReady(): void {
  settings.defaultBackend = 'imgrouter';
  settings.imgrouter.url = 'https://imgrouter.example';
  settings.imgrouter.key = 'k';
  settings.imgrouter.model = 'foo';
}

describe('backendStatus', () => {
  it('reports each missing NAI field by name', () => {
    naiReady();
    expect(backendStatus()).toMatchObject({ configured: true, reason: '' });

    settings.nai.key = '  ';
    expect(backendStatus()).toMatchObject({ configured: false, reason: '未填写 NAI API Key' });

    settings.nai.url = '  ';
    expect(backendStatus()).toMatchObject({ configured: false, reason: '未填写 NAI 服务地址' });
  });

  it('answers supportsCharacters from the model alone, even before the key is filled in', () => {
    naiReady();
    settings.nai.key = '';
    // 第三方要在出图**前**就知道该不该传 characters,不能等配好了才知道
    expect(backendStatus().supportsCharacters).toBe(true);
  });

  it('keeps ComfyUI at supportsCharacters=false (the pipeline never reads the field)', () => {
    comfyReady();
    expect(backendStatus()).toMatchObject({ configured: true, supportsCharacters: false });
  });

  it('flags an unconfigured ComfyUI without pretending it can draw', () => {
    comfyReady();
    settings.comfyui.workflows[0].workflow = '  ';
    expect(backendStatus()).toMatchObject({
      configured: false,
      reason: '当前工作流预设未填写工作流 JSON',
    });
  });

  it('treats Latent like NAI for configured + supportsCharacters', () => {
    latentReady();
    expect(backendStatus()).toMatchObject({
      backend: 'latent',
      configured: true,
      supportsCharacters: true,
      model: 'nai-diffusion-4-5-full',
    });
    settings.latent.key = '';
    expect(backendStatus()).toMatchObject({
      configured: false,
      reason: '未填写 Latent API Key',
      supportsCharacters: true,
    });
  });

  it('keeps ImgRouter at supportsCharacters=false and uses the model or a fallback label', () => {
    imgrouterReady();
    expect(backendStatus()).toMatchObject({
      backend: 'imgrouter',
      configured: true,
      supportsCharacters: false,
      model: 'foo',
    });
    settings.imgrouter.model = '  ';
    expect(backendStatus().model).toBe('(渠道默认)');
    settings.imgrouter.key = '';
    expect(backendStatus()).toMatchObject({
      configured: false,
      reason: '未填写 ImgRouter 访问令牌',
    });
  });
});

describe('decideSeed', () => {
  it('prefers an explicit seed over everything else', () => {
    naiReady();
    settings.nai.seed = 999;
    expect(decideSeed('nai', 12345)).toBe(12345);
    expect(decideSeed('nai', 12345.7)).toBe(12345);
  });

  it('uses the NAI panel seed only when it is a positive number', () => {
    naiReady();
    settings.nai.seed = 777;
    expect(decideSeed('nai')).toBe(777);
    settings.nai.seed = 0;
    expect(decideSeed('nai')).not.toBe(0);
  });

  it.each([0, -1, NaN, undefined])('ignores %s as an override and still returns a usable seed', value => {
    naiReady();
    settings.nai.seed = 0;
    const seed = decideSeed('nai', value as number | undefined);
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThan(0);
  });

  it('always stores 0 for ImgRouter unless an explicit seed is given', () => {
    imgrouterReady();
    expect(decideSeed('imgrouter')).toBe(0);
    expect(decideSeed('imgrouter', 12345)).toBe(12345);
  });

  it('reads the Latent panel seed the same way as NAI', () => {
    latentReady();
    settings.latent.seed = 888;
    expect(decideSeed('latent')).toBe(888);
  });
});

describe('generateImage', () => {
  it('holds a NAI gate slot and always releases it — even when the request throws', async () => {
    naiReady();
    const release = vi.fn();
    vi.mocked(acquireNaiSlot).mockResolvedValue(release);

    await generateImage({ prompt: '1girl', seed: 1 });
    expect(vi.mocked(acquireNaiSlot)).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);

    vi.mocked(generateNaiImage).mockRejectedValueOnce(new Error('429'));
    await expect(generateImage({ prompt: '1girl', seed: 1 })).rejects.toThrow('429');
    // 漏一次 release 就永久少一格并发,漏满就再也发不出请求
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('leaves ComfyUI out of the gate (its queue lives on the server)', async () => {
    comfyReady();
    await generateImage({ prompt: '1girl', seed: 1 });
    expect(vi.mocked(acquireNaiSlot)).not.toHaveBeenCalled();
  });

  it('passes characters through untouched — nai.ts owns the model predicate', async () => {
    naiReady();
    const characters = [{ name: '阿黛尔', tag: '1girl', nl: '' }];
    await generateImage({ prompt: 'x', characters, seed: 5, size: 'landscape' });
    expect(vi.mocked(generateNaiImage).mock.calls[0][1]).toEqual({
      prompt: 'x', nl: '', characters, seed: 5, size: 'landscape', flatten: false,
    });
  });

  it('says charactersApplied=false when the model cannot take them', async () => {
    naiReady('nai-diffusion-3');
    const characters = [{ name: 'a', tag: 'b', nl: '' }];
    const applied = await generateImage({ prompt: 'x', characters, seed: 1 });
    expect(applied.charactersApplied).toBe(false);

    naiReady();
    expect((await generateImage({ prompt: 'x', characters, seed: 1 })).charactersApplied).toBe(true);
    // 没传角色时不该报「用上了」
    expect((await generateImage({ prompt: 'x', seed: 1 })).charactersApplied).toBe(false);
  });

  it('refuses to fire a doomed request when the backend is not configured', async () => {
    naiReady();
    settings.nai.key = '';
    await expect(generateImage({ prompt: 'x', seed: 1 })).rejects.toThrow('未填写 NAI API Key');
    expect(vi.mocked(generateNaiImage)).not.toHaveBeenCalled();
  });

  it('clears the retry banner once the image is in hand', async () => {
    naiReady();
    const onRetry = vi.fn();
    await generateImage({ prompt: 'x', seed: 1 }, undefined, { onRetry });
    // 落盘还要一会儿,这段时间不该继续显示「稍后重试」
    expect(onRetry).toHaveBeenLastCalledWith(null);
  });

  it('only fires onStart after the slot is in hand (that is the queued→generating moment)', async () => {
    naiReady();
    const order: string[] = [];
    vi.mocked(acquireNaiSlot).mockImplementation(async () => {
      order.push('slot');
      return () => {};
    });
    await generateImage({ prompt: 'x', seed: 1 }, undefined, { onStart: () => order.push('start') });
    expect(order).toEqual(['slot', 'start']);
  });

  it('sends the dynamic negative to ComfyUI (NAI takes its negative from settings)', async () => {
    comfyReady();
    await generateImage({ prompt: 'x', negative: 'bad hands', seed: 9 }, undefined, {});
    expect(vi.mocked(generateComfyImage).mock.calls[0][1]).toMatchObject({
      negative_prompt: 'bad hands',
      seed: 9,
      size: 'portrait',
    });
  });

  it('holds the NAI gate for Latent and flattens Character Prompts into the prompt', async () => {
    latentReady();
    const characters = [{ name: '阿黛尔', tag: '1girl', nl: '' }];
    await generateImage({ prompt: 'x', characters, seed: 5, size: 'portrait' });
    expect(vi.mocked(acquireNaiSlot)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(generateNaiImage).mock.calls[0][0]).toBe(settings.latent);
    expect(vi.mocked(generateNaiImage).mock.calls[0][1]).toMatchObject({
      prompt: 'x',
      characters,
      seed: 5,
      flatten: true,
    });
    expect((await generateImage({ prompt: 'x', characters, seed: 1 })).charactersApplied).toBe(true);
  });

  it('leaves ImgRouter out of the gate and does not apply characters', async () => {
    imgrouterReady();
    const characters = [{ name: 'a', tag: 'b', nl: '' }];
    const out = await generateImage({ prompt: 'x', characters, seed: 1 });
    expect(vi.mocked(acquireNaiSlot)).not.toHaveBeenCalled();
    expect(vi.mocked(generateImgRouterImage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(generateNaiImage)).not.toHaveBeenCalled();
    expect(out.charactersApplied).toBe(false);
    expect(vi.mocked(generateImgRouterImage).mock.calls[0][1]).toMatchObject({
      prompt: 'x',
      size: 'portrait',
    });
  });
});
