import type {
  NaiArtistPreset,
  NaiPresetParams,
  NaiSettings,
  NaiVibe,
} from '@/state/settings';

/**
 * 画师串库的管理态纯逻辑(搜索匹配 / 删除接位规划 / Vibe 绑定)。
 * 与交互解耦,便于单测;NaiArtistManager.vue 只做交互与落盘。
 */

/** 切换画师串时套用其 Vibe 绑定:undefined = 未绑定,不动;[] = 明确不使用,全部关闭。 */
export function applyArtistVibeState(
  vibes: readonly NaiVibe[],
  preset: Pick<NaiArtistPreset, 'vibes'>,
): void {
  if (!preset.vibes) return;
  const refs = new Map(preset.vibes.map(ref => [ref.id, ref]));
  for (const vibe of vibes) {
    const ref = refs.get(vibe.id);
    vibe.enabled = ref?.enabled ?? false;
    if (ref) vibe.strength = ref.strength;
  }
}

/** 把当前渠道参数拍成快照(导出与「保存当前参数」共用)。 */
export function snapshotNaiPresetParams(conn: NaiSettings): NaiPresetParams {
  return {
    model: conn.model,
    sampler: conn.sampler,
    steps: conn.steps,
    scale: conn.scale,
    cfgRescale: conn.cfgRescale,
    noiseSchedule: conn.noiseSchedule,
    varietyBoost: conn.varietyBoost,
    normalizeRefStrength: conn.normalizeRefStrength,
    portraitSize: conn.portraitSize,
    landscapeSize: conn.landscapeSize,
  };
}

/** 把预设参数写回渠道;只由用户显式点「应用参数」触发,切换画师串不自动调用。 */
export function applyNaiPresetParams(conn: NaiSettings, params: NaiPresetParams): void {
  conn.model = params.model;
  conn.sampler = params.sampler;
  conn.steps = params.steps;
  conn.scale = params.scale;
  conn.cfgRescale = params.cfgRescale;
  conn.noiseSchedule = params.noiseSchedule;
  conn.varietyBoost = params.varietyBoost;
  conn.normalizeRefStrength = params.normalizeRefStrength;
  conn.portraitSize = params.portraitSize;
  conn.landscapeSize = params.landscapeSize;
}

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
