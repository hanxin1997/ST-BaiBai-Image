import { describe, expect, it } from 'vitest';

import { isWorldInfoEntryExcluded, sortWorldInfoEntriesLikeST } from '@/autoTag/excludes';
import type { WorldInfoEntry } from '@/st/context';
import type { ExcludesSettings } from '@/state/settings';

function excludes(partial: Partial<ExcludesSettings>): ExcludesSettings {
  return {
    excludedChars: [],
    excludedWorldNames: [],
    excludedWorldInfoPatterns: [],
    customStripTags: [],
    ...partial,
  };
}

function entry(partial: Partial<WorldInfoEntry>): WorldInfoEntry {
  return { world: '主世界', comment: '设定', content: '…', ...partial };
}

describe('isWorldInfoEntryExcluded', () => {
  it('整本排除:world 名精确匹配即排除', () => {
    const ex = excludes({ excludedWorldNames: ['附加知识'] });
    expect(isWorldInfoEntryExcluded(entry({ world: '附加知识' }), ex)).toBe(true);
    expect(isWorldInfoEntryExcluded(entry({ world: '主世界' }), ex)).toBe(false);
  });

  it('条目名规则:普通名字即包含匹配,大小写不敏感', () => {
    const ex = excludes({ excludedWorldInfoPatterns: ['附加'] });
    expect(isWorldInfoEntryExcluded(entry({ comment: '附加设定' }), ex)).toBe(true);
    expect(isWorldInfoEntryExcluded(entry({ comment: '核心设定' }), ex)).toBe(false);
    // 大小写不敏感:填 mvu 命中 [MVU]
    expect(isWorldInfoEntryExcluded(entry({ comment: '[MVU] 框架' }), excludes({ excludedWorldInfoPatterns: ['mvu'] }))).toBe(true);
  });

  it('条目名规则:按正则编译,^锚定生效', () => {
    const ex = excludes({ excludedWorldInfoPatterns: ['^规则'] });
    expect(isWorldInfoEntryExcluded(entry({ comment: '规则说明' }), ex)).toBe(true);
    expect(isWorldInfoEntryExcluded(entry({ comment: '附:规则补充' }), ex)).toBe(false);
  });

  it('非法正则降级为字面子串包含(大小写不敏感),不误伤', () => {
    // 未闭合括号:非法正则 → 退化为字面子串比对(含原样元字符),不是把元字符当通配
    const ex = excludes({ excludedWorldInfoPatterns: ['(临时'] });
    expect(isWorldInfoEntryExcluded(entry({ comment: '设定(临时)补充' }), ex)).toBe(true);
    expect(isWorldInfoEntryExcluded(entry({ comment: '设定临时补充' }), ex)).toBe(false);
  });

  it('comment 为空 / 名单为空 / 全空条目:不排除', () => {
    const ex = excludes({ excludedWorldNames: ['附加'], excludedWorldInfoPatterns: ['附加'] });
    expect(isWorldInfoEntryExcluded(entry({ comment: '' }), ex)).toBe(false);
    expect(isWorldInfoEntryExcluded(entry({ comment: '附加设定' }), excludes({}))).toBe(false);
    expect(isWorldInfoEntryExcluded(entry({ world: '', comment: '' }), ex)).toBe(false);
  });

  it('world 名带首尾空白时 trim 后匹配', () => {
    const ex = excludes({ excludedWorldNames: ['附加知识'] });
    expect(isWorldInfoEntryExcluded(entry({ world: ' 附加知识 ' }), ex)).toBe(true);
  });
});

describe('sortWorldInfoEntriesLikeST', () => {
  function e(position: number | undefined, order: number | undefined, depth?: number): WorldInfoEntry {
    return { world: '主世界', comment: 'c', content: 'x', position, order, depth };
  }

  it('桶间按 ST 出现先后:before → after → 作者注 → @深度 → EM', () => {
    const entries = [
      e(4, 100), // @深度
      e(1, 100), // 角色后
      e(2, 100), // 作者注前
      e(0, 100), // 角色前
      e(5, 100), // EM 上
      e(6, 100), // EM 下
    ];
    const out = sortWorldInfoEntriesLikeST(entries);
    expect(out.map(x => x.position)).toEqual([0, 1, 2, 4, 5, 6]);
  });

  it('桶内按 order 升序;缺失按默认 100 兑底', () => {
    const entries = [e(0, 200), e(0, undefined), e(0, 50)];
    const out = sortWorldInfoEntriesLikeST(entries);
    expect(out.map(x => x.order)).toEqual([50, undefined, 200]);
  });

  it('@深度桶内:depth 大的先出现,再按 order 升序', () => {
    const entries = [e(4, 100, 2), e(4, 100, 8), e(4, 50, 8)];
    const out = sortWorldInfoEntriesLikeST(entries);
    expect(out.map(x => x.depth)).toEqual([8, 8, 2]);
    expect(out[0].order).toBe(50);
    expect(out[1].order).toBe(100);
  });

  it('未知 position 归入「其他」排末尾,不丢条目', () => {
    const entries = [e(7, 100), e(0, 100), e(99, 100)];
    const out = sortWorldInfoEntriesLikeST(entries);
    expect(out.map(x => x.position)).toEqual([0, 7, 99]);
  });

  it('不修改原数组', () => {
    const entries = [e(1, 100), e(0, 100)];
    sortWorldInfoEntriesLikeST(entries);
    expect(entries.map(x => x.position)).toEqual([1, 0]);
  });
});
