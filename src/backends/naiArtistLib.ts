import type { NaiArtistPreset } from '@/state/settings';

/**
 * 画师串库的管理态纯逻辑(搜索匹配 / 删除接位规划)。
 * 与交互解耦,便于单测;NaiArtistManager.vue 只做交互与落盘。
 */

/**
 * 搜索匹配:名称 + 画师串内容,大小写不敏感的子串匹配;空词恒真(= 不过滤)。
 * 绑定的正/负面词不参与——用户记画风靠的是名字和那串 artist tag,
 * 匹配面铺得越广,「明明搜到了」与「这怎么也命中」的意外都越多。
 */
export function matchArtist(
  preset: Pick<NaiArtistPreset, 'name' | 'prompt'>,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return preset.name.toLowerCase().includes(q) || preset.prompt.toLowerCase().includes(q);
}

export interface ArtistRemovalPlan {
  /** 删除后的库(保持原顺序)。 */
  remaining: NaiArtistPreset[];
  /** 实际被删的条目(调用方据此清理预览图文件)。 */
  removed: NaiArtistPreset[];
  /**
   * 删除后的 activeArtistId:当前项没被动 → 不动;
   * 当前项被删 → 接位到原位置那一条(已是末尾则退一格),删空 → ''(= 不使用)。
   * 与 NaiPanel 单条删除的接位口径一致,刻意**不**回落 [0](静默换画风查不出原因)。
   */
  nextActiveId: string;
}

/**
 * 规划一次删除(单条与批量共用)。removedIds 之外的条目不碰;
 * activeId 不在删除集里就原样保留(内置 bi_* 永不在删除集——管理器不给内置条勾选框)。
 */
export function planArtistRemoval(
  list: readonly NaiArtistPreset[],
  removedIds: ReadonlySet<string>,
  activeId: string,
): ArtistRemovalPlan {
  const removed = list.filter(a => removedIds.has(a.id));
  const remaining = list.filter(a => !removedIds.has(a.id));
  let nextActiveId = activeId;
  if (removedIds.has(activeId)) {
    const index = list.findIndex(a => removedIds.has(a.id));
    nextActiveId = remaining[Math.min(index, remaining.length - 1)]?.id ?? '';
  }
  return { remaining, removed, nextActiveId };
}
