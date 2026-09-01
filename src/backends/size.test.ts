import { describe, expect, it } from 'vitest';

import { normalizeOrientation, parseSize, pickSize } from '@/backends/size';

describe('normalizeOrientation', () => {
  it('认标准值与大小写/空白变体', () => {
    expect(normalizeOrientation('portrait')).toBe('portrait');
    expect(normalizeOrientation('landscape')).toBe('landscape');
    expect(normalizeOrientation('  LANDSCAPE  ')).toBe('landscape');
  });

  it('认常见同义写法与中文', () => {
    expect(normalizeOrientation('horizontal')).toBe('landscape');
    expect(normalizeOrientation('wide')).toBe('landscape');
    expect(normalizeOrientation('横屏')).toBe('landscape');
    expect(normalizeOrientation('landscape shot')).toBe('landscape');
    expect(normalizeOrientation('l')).toBe('landscape');
    expect(normalizeOrientation('vertical')).toBe('portrait');
  });

  it('认比例/尺寸写法,按宽高关系判定', () => {
    expect(normalizeOrientation('16:9')).toBe('landscape');
    expect(normalizeOrientation('9:16')).toBe('portrait');
    expect(normalizeOrientation('1216x832')).toBe('landscape');
    expect(normalizeOrientation('832×1216')).toBe('portrait');
    expect(normalizeOrientation('1:1')).toBe('portrait');
  });

  it('缺失或无法识别一律降级为竖屏(维持改动前的固定默认)', () => {
    expect(normalizeOrientation(undefined)).toBe('portrait');
    expect(normalizeOrientation(null)).toBe('portrait');
    expect(normalizeOrientation('')).toBe('portrait');
    expect(normalizeOrientation('   ')).toBe('portrait');
    expect(normalizeOrientation(42)).toBe('portrait');
    expect(normalizeOrientation({ size: 'landscape' })).toBe('portrait');
    expect(normalizeOrientation('随便写点什么')).toBe('portrait');
  });
});

describe('parseSize', () => {
  it('解析各种分隔符', () => {
    expect(parseSize('832×1216')).toEqual({ width: 832, height: 1216 });
    expect(parseSize('1216x832')).toEqual({ width: 1216, height: 832 });
    expect(parseSize('1024 * 1024')).toEqual({ width: 1024, height: 1024 });
  });

  it('解析不出或超范围返回 null,由调用方决定报错还是降级', () => {
    expect(parseSize('')).toBeNull();
    expect(parseSize('竖版')).toBeNull();
    expect(parseSize('8000×8000')).toBeNull();
    expect(parseSize('32×32')).toBeNull();
  });

  it('不强制 64 的倍数(那是 NAI 专属限制,由 parseResolution 另外把关)', () => {
    expect(parseSize('830×1216')).toEqual({ width: 830, height: 1216 });
  });
});

describe('pickSize', () => {
  const pair = { portraitSize: '832×1216', landscapeSize: '1216×832' };

  it('按方向取对应那一格', () => {
    expect(pickSize(pair, 'portrait')).toBe('832×1216');
    expect(pickSize(pair, 'landscape')).toBe('1216×832');
  });

  it('未填返回空串,交由调用方回落', () => {
    expect(pickSize({ portraitSize: '  ', landscapeSize: '' }, 'portrait')).toBe('');
    expect(pickSize({ portraitSize: '', landscapeSize: '' }, 'landscape')).toBe('');
  });
});
