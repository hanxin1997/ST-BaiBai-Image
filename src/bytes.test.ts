import { describe, expect, it } from 'vitest';

import { formatBytes } from '@/bytes';

describe('formatBytes', () => {
  it('按 1024 进制换算到合适的单位', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(311300)).toBe('304 KB');
    expect(formatBytes(11 * 1024 * 1024)).toBe('11 MB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
  });

  it('不足 10 留一位小数,10 以上抹掉', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(9.94 * 1024)).toBe('9.9 KB');
    // 越过 10 就不再给小数:角标里那位只是噪声
    expect(formatBytes(10.4 * 1024)).toBe('10 KB');
  });

  it('字节本身不给小数', () => {
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('封顶在 TB,不会溢出单位表', () => {
    expect(formatBytes(1024 ** 5)).toBe('1024 TB');
  });

  it('非有限值与负数返回空串,不伪装成 0 B', () => {
    // 「还没算出来」必须和「算出来是空的」区分开,故不给兜底值
    expect(formatBytes(NaN)).toBe('');
    expect(formatBytes(Infinity)).toBe('');
    expect(formatBytes(-1)).toBe('');
  });
});
