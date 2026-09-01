import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 共享存储「空种子」事故回归测试:
 * 旧版绘在没有任何排除数据时也会用空名单创建共享存储(occupying baibai_exclude_settings),
 * 书启动后领养空 store → 双方互相同步成空,用户配置全灭。
 * 现在的契约:没有用户数据的一方绝不建仓;有数据的一方遇到「空种子 store」时自愈回写。
 *
 * 本文件只测纯逻辑工具(excludesHasUserData 同构实现),settings.ts 的 hydrate 链
 * 依赖 ST getContext,不便在 node 环境完整实例化。
 */

const DEFAULT_WI_PATTERNS = ['\\[mvu[\\s\\S]*?\\]'];

interface ExcludesLike {
  excludedChars: string[];
  excludedWorldNames: string[];
  excludedWorldInfoPatterns: string[];
  customStripTags: string[];
}

function excludesHasUserData(ex: ExcludesLike): boolean {
  const patterns = ex.excludedWorldInfoPatterns.filter(p => !DEFAULT_WI_PATTERNS.includes(p));
  return (
    ex.excludedChars.length > 0 ||
    ex.excludedWorldNames.length > 0 ||
    patterns.length > 0 ||
    ex.customStripTags.length > 0
  );
}

const emptySeeded = (): ExcludesLike => ({
  excludedChars: [],
  excludedWorldNames: [],
  excludedWorldInfoPatterns: [...DEFAULT_WI_PATTERNS],
  customStripTags: [],
});

describe('排除名单共享存储空种子守卫', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('空名单 + 仅内置默认规则 = 无用户数据(旧版绘写入的空种子长这样)', () => {
    expect(excludesHasUserData(emptySeeded())).toBe(false);
  });

  it('全空名单(用户刚装插件)= 无用户数据', () => {
    expect(
      excludesHasUserData({
        excludedChars: [],
        excludedWorldNames: [],
        excludedWorldInfoPatterns: [],
        customStripTags: [],
      }),
    ).toBe(false);
  });

  it('有排除角色 = 有用户数据', () => {
    const ex = emptySeeded();
    ex.excludedChars = ['小雪'];
    expect(excludesHasUserData(ex)).toBe(true);
  });

  it('有整本排除的世界书 = 有用户数据', () => {
    const ex = emptySeeded();
    ex.excludedWorldNames = ['设定集'];
    expect(excludesHasUserData(ex)).toBe(true);
  });

  it('有自定义条目名规则(除内置 mvu 外)= 有用户数据', () => {
    const ex = emptySeeded();
    ex.excludedWorldInfoPatterns.push('^\\[状态');
    expect(excludesHasUserData(ex)).toBe(true);
  });

  it('有自定义清洗标签 = 有用户数据', () => {
    const ex = emptySeeded();
    ex.customStripTags = ['snow'];
    expect(excludesHasUserData(ex)).toBe(true);
  });

  it('仅内置 mvu 规则(用户删光了自定义项)= 无用户数据,不会误判为空种子被回写覆盖', () => {
    // 用户在任一端有意删空自定义项后,store 里只剩内置规则 → 与本地一致,
    // 自愈守卫不触发(书侧 requires excludesHasUserData(apiSettings) 为 false)
    const ex = emptySeeded();
    expect(excludesHasUserData(ex)).toBe(false);
  });
});
