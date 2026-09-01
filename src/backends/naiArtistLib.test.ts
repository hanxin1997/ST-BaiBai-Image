import { describe, expect, it } from 'vitest';
import { matchArtist, planArtistRemoval } from '@/backends/naiArtistLib';
import type { NaiArtistPreset } from '@/state/settings';

function preset(id: string, name = id, prompt = ''): NaiArtistPreset {
  return { id, name, prompt, quality: '', negative: '' };
}

describe('matchArtist', () => {
  it('空词恒真(不过滤)', () => {
    expect(matchArtist(preset('a', '厚涂', 'artist:wlop'), '')).toBe(true);
    expect(matchArtist(preset('a', '厚涂', 'artist:wlop'), '   ')).toBe(true);
  });

  it('按名称与画师串内容匹配,大小写不敏感', () => {
    const p = preset('a', '厚涂', 'artist:WLOP, artist:as109');
    expect(matchArtist(p, '厚涂')).toBe(true);
    expect(matchArtist(p, 'wlop')).toBe(true);
    expect(matchArtist(p, 'AS109')).toBe(true);
    expect(matchArtist(p, '油画')).toBe(false);
  });
});

describe('planArtistRemoval', () => {
  const list = [preset('a'), preset('b'), preset('c'), preset('d')];

  it('当前项未被删 → activeArtistId 不动', () => {
    const plan = planArtistRemoval(list, new Set(['b', 'c']), 'a');
    expect(plan.remaining.map(p => p.id)).toEqual(['a', 'd']);
    expect(plan.removed.map(p => p.id)).toEqual(['b', 'c']);
    expect(plan.nextActiveId).toBe('a');
  });

  it('当前项被删 → 接位到原位置那一条', () => {
    const plan = planArtistRemoval(list, new Set(['b']), 'b');
    expect(plan.remaining.map(p => p.id)).toEqual(['a', 'c', 'd']);
    expect(plan.nextActiveId).toBe('c');
  });

  it('删的是末尾 → 退一格', () => {
    const plan = planArtistRemoval(list, new Set(['d']), 'd');
    expect(plan.nextActiveId).toBe('c');
  });

  it('删空 → 回「不使用」', () => {
    const plan = planArtistRemoval(list, new Set(['a', 'b', 'c', 'd']), 'c');
    expect(plan.remaining).toEqual([]);
    expect(plan.nextActiveId).toBe('');
  });

  it('批量删除含当前项 → 接位到最前一个被删位置', () => {
    // b、c 都删,接位取 min(原第一个被删下标 1, 剩余长度-1) → remaining[1] = d
    const plan = planArtistRemoval(list, new Set(['b', 'c']), 'c');
    expect(plan.remaining.map(p => p.id)).toEqual(['a', 'd']);
    expect(plan.nextActiveId).toBe('d');
  });

  it('内置 id(bi_*)不会出现在删除集 → 当前内置条不受影响', () => {
    const plan = planArtistRemoval(list, new Set(['a']), 'bi_default');
    expect(plan.nextActiveId).toBe('bi_default');
  });
});
