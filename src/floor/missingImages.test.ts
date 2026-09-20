import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed } from 'vue';

import {
  confirmImageMissing,
  isImageMissing,
  markImageMissing,
  markImagesMissing,
  normalizeImagePath,
  resetMissingImages,
} from '@/floor/missingImages';
import { probeUserImage } from '@/st/images';

vi.mock('@/st/images', () => ({ probeUserImage: vi.fn() }));

beforeEach(() => {
  resetMissingImages();
  vi.mocked(probeUserImage).mockReset();
});

describe('normalizeImagePath', () => {
  it('解码并去掉前导斜杠,让 extra 与图库两侧的写法能相等', () => {
    // extra 里是服务端原样返回的未编码路径,图库那边是逐段 encodeURIComponent 的
    const fromExtra = '/user/images/柏宝绘_爱丽丝/bbi_a_0_b-g1.png';
    const fromGallery = 'user/images/%E6%9F%8F%E5%AE%9D%E7%BB%98_%E7%88%B1%E4%B8%BD%E4%B8%9D/bbi_a_0_b-g1.png';
    expect(normalizeImagePath(fromExtra)).toBe(normalizeImagePath(fromGallery));
  });

  it('半截百分号编码不抛错,按原文比', () => {
    expect(normalizeImagePath('/user/images/100%/a.png')).toBe('user/images/100%/a.png');
  });
});

describe('missingImages', () => {
  it('标记后按归一化口径命中,编码与否都认', () => {
    markImageMissing('/user/images/柏宝绘_爱丽丝/a.png');
    expect(isImageMissing('user/images/%E6%9F%8F%E5%AE%9D%E7%BB%98_%E7%88%B1%E4%B8%BD%E4%B8%9D/a.png')).toBe(true);
    expect(isImageMissing('/user/images/柏宝绘_爱丽丝/a.png')).toBe(true);
  });

  it('未标记的图不算缺失', () => {
    markImageMissing('/user/images/柏宝绘_爱丽丝/a.png');
    expect(isImageMissing('/user/images/柏宝绘_爱丽丝/b.png')).toBe(false);
  });

  it('批量标记', () => {
    markImagesMissing(['/user/images/f/a.png', '/user/images/f/b.png']);
    expect(isImageMissing('/user/images/f/a.png')).toBe(true);
    expect(isImageMissing('/user/images/f/b.png')).toBe(true);
  });

  it('空路径既不写入也不命中', () => {
    markImageMissing('');
    expect(isImageMissing('')).toBe(false);
  });
});

describe('confirmImageMissing', () => {
  const path = '/user/images/柏宝绘_爱丽丝/a.png';

  it('服务端明确 404 才落册', async () => {
    vi.mocked(probeUserImage).mockResolvedValue({ exists: false });
    expect(await confirmImageMissing(path)).toBe(true);
    expect(isImageMissing(path)).toBe(true);
  });

  it('探不清(网络错误/500)绝不落册', async () => {
    // <img> 的 error 分不清「文件没了」和「网断了」。把掉线记成删除,
    // 用户网一抖就满屏「文件已删除」,且刷新前好不了。
    vi.mocked(probeUserImage).mockResolvedValue(null);
    expect(await confirmImageMissing(path)).toBe(false);
    expect(isImageMissing(path)).toBe(false);
  });

  it('文件还在则不落册', async () => {
    vi.mocked(probeUserImage).mockResolvedValue({ exists: true, size: 1024 });
    expect(await confirmImageMissing(path)).toBe(false);
    expect(isImageMissing(path)).toBe(false);
  });

  it('同一张图只探一次:已在册的直接返回,并发的后来者不重复发请求', async () => {
    let settle!: (probe: { exists: false }) => void;
    vi.mocked(probeUserImage).mockReturnValue(new Promise(resolve => { settle = resolve; }));
    // 重水合会重挂 <img>,error 会再来一遍
    const first = confirmImageMissing(path);
    expect(await confirmImageMissing(path)).toBe(false); // 在途,不再发第二个 HEAD
    settle({ exists: false });
    expect(await first).toBe(true);
    expect(vi.mocked(probeUserImage)).toHaveBeenCalledTimes(1);

    expect(await confirmImageMissing(path)).toBe(true); // 已在册,直接命中
    expect(vi.mocked(probeUserImage)).toHaveBeenCalledTimes(1);
  });

  it('只认 user/images 下的图:老图与外来路径一律不探', async () => {
    // user/files 里的老图本插件不删,没有「被图库删掉」这条路径
    vi.mocked(probeUserImage).mockResolvedValue({ exists: false });
    expect(await confirmImageMissing('/user/files/old.png')).toBe(false);
    expect(await confirmImageMissing('https://example.com/a.png')).toBe(false);
    expect(await confirmImageMissing('')).toBe(false);
    expect(vi.mocked(probeUserImage)).not.toHaveBeenCalled();
  });

  it('编码过的路径也认得出是 user/images,并与未编码写法同键', async () => {
    vi.mocked(probeUserImage).mockResolvedValue({ exists: false });
    const encoded = 'user/images/%E6%9F%8F%E5%AE%9D%E7%BB%98_%E7%88%B1%E4%B8%BD%E4%B8%9D/a.png';
    expect(await confirmImageMissing(encoded)).toBe(true);
    expect(isImageMissing(path)).toBe(true);
  });

  it('探测抛出时释放在途标记,下次还能重试', async () => {
    vi.mocked(probeUserImage).mockRejectedValueOnce(new Error('boom'));
    await expect(confirmImageMissing(path)).rejects.toThrow('boom');
    vi.mocked(probeUserImage).mockResolvedValue({ exists: false });
    expect(await confirmImageMissing(path)).toBe(true);
  });
});

describe('响应式', () => {
  // 卡片的 liveHistory/liveStale/filesGone 全是 computed(isImageMissing(...))。
  // 本册若退化成普通 Set,标记后卡片不会重算——图库删完图,已打开的楼层照旧显示破图,
  // 要等下一次水合才好。这条锁的是「标记能推动 computed」,不是 Set 的语义。
  it('标记后 computed 立刻重算', () => {
    const a = '/user/images/f/a.png';
    const gone = computed(() => isImageMissing(a));
    expect(gone.value).toBe(false);
    markImageMissing(a);
    expect(gone.value).toBe(true);
  });

  it('只惊动被标记的那张,不连坐同目录的其它图', () => {
    const b = '/user/images/f/b.png';
    const gone = computed(() => isImageMissing(b));
    expect(gone.value).toBe(false);
    markImageMissing('/user/images/f/a.png');
    expect(gone.value).toBe(false);
  });
});
