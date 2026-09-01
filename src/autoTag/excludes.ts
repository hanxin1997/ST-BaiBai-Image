import type { WorldInfoEntry } from '@/st/context';
import type { ExcludesSettings } from '@/state/settings';

/**
 * 世界书条目过滤与排序(与柏宝书 engine.ts 完全同口径,改动需双端同步):
 *   - isWorldInfoEntryExcluded:整本排除(world 命中名单)+ 按条目名(comment)命中任一规则;
 *   - sortWorldInfoEntriesLikeST:把激活条目排成 ST 主提示词同款顺序。
 * 名单来自共享存储(settings.excludes),与柏宝书同一份。
 */

/**
 * 判断某条条目是否应被排除:① 整本排除(world 命中名单);② 条目名(comment)命中任一规则。
 * 规则按正则编译、**大小写不敏感**(填 mvu 命中 [MVU]);普通名字天然=包含匹配。
 * 编译失败降级为字面子串包含(大小写不敏感)——用户填了带元字符的普通名字(如「(临时)」)
 * 也不会误伤,只是退化成子串比对。与柏宝书 engine.ts 的 isWorldInfoEntryExcluded 同逻辑。
 */
export function isWorldInfoEntryExcluded(entry: WorldInfoEntry, excludes: ExcludesSettings): boolean {
  const world = entry.world?.trim();
  if (world && excludes.excludedWorldNames.includes(world)) return true;
  const comment = entry.comment?.trim();
  if (!comment) return false;
  for (const raw of excludes.excludedWorldInfoPatterns) {
    const pat = raw.trim();
    if (!pat) continue;
    let hit = false;
    try {
      hit = new RegExp(pat, 'i').test(comment);
    } catch {
      hit = comment.toLowerCase().includes(pat.toLowerCase()); // 非法正则 → 退化为字面子串包含
    }
    if (hit) return true;
  }
  return false;
}

// 世界书条目插入位置枚举(对齐 ST world_info_position;未知值归入「其他」排最后,不丢条目)
const WI_POSITION_BEFORE = 0;
const WI_POSITION_AT_DEPTH = 4;

// 桶序:复刻 ST 主提示词中各类条目出现的先后(openai.js populateChatCompletion 的加入顺序):
// worldInfoBefore(0 角色前) → worldInfoAfter(1 角色后) → 作者注前(2) → 作者注后(3) → @深度(4) → EM上(5) → EM下(6)
// 出口(outlet,7)由 PromptManager 模板位置决定,无固定先后,归入「其他」排末尾。
const WI_BUCKET_ORDER: Record<number, number> = {
  0: 0, // before 角色前
  1: 1, // after 角色后
  2: 2, // ANTop 作者注前
  3: 3, // ANBottom 作者注后
  4: 4, // atDepth @深度
  5: 5, // EMTop EM 上锚
  6: 6, // EMBottom EM 下锚
  7: 99, // outlet 出口:无固定位置,统一归入其他
};

/** ST 新建条目的默认 Order(world-info.js newWorldInfoEntryDefinition.order.default) */
const WI_DEFAULT_ORDER = 100;

/** ST 新建条目的默认深度(newWorldInfoEntryDefinition.depth.default = DEFAULT_DEPTH) */
const WI_DEFAULT_DEPTH = 4;

/**
 * 把激活条目排成 ST 主提示词同款顺序(桶内 order 升序 + 桶间按出现先后):
 * ST 内部(world-info.js 末段)是「按 order 降序遍历 + unshift 头插」→ 等效同位置内 order 升序;
 * 我们拿到的 allActivatedEntries 是扫描命中顺序(Set/Map 插入序),不含这一步,故在此复刻。
 * 桶间顺序按它们进入主提示词的先后(角色前 → 角色后 → 作者注前/后 → @深度 → EM);
 * @深度桶内再按 depth 降序(深度大的在提示词里更早出现)后按 order 升序。
 * position/order/depth 缺失时用 ST 默认值(0/100/4)兑底;未知 position 归入「其他」排末尾。
 * 与柏宝书 engine.ts 的 sortWorldInfoEntriesLikeST 同逻辑。
 */
export function sortWorldInfoEntriesLikeST(entries: WorldInfoEntry[]): WorldInfoEntry[] {
  return [...entries].sort((a, b) => {
    const pa = WI_BUCKET_ORDER[Number(a.position ?? WI_POSITION_BEFORE)] ?? 99;
    const pb = WI_BUCKET_ORDER[Number(b.position ?? WI_POSITION_BEFORE)] ?? 99;
    if (pa !== pb) return pa - pb;
    // 同为 @深度:深度大的先出现(提示词里离对话更远)
    if (pa === WI_BUCKET_ORDER[WI_POSITION_AT_DEPTH]) {
      const da = Number(a.depth ?? WI_DEFAULT_DEPTH);
      const db = Number(b.depth ?? WI_DEFAULT_DEPTH);
      if (da !== db) return db - da;
    }
    // 桶内:order 升序(ST 的降序遍历+头插等效结果);非数字/缺失按默认 100
    const oa = Number.isFinite(a.order as number) ? Number(a.order) : WI_DEFAULT_ORDER;
    const ob = Number.isFinite(b.order as number) ? Number(b.order) : WI_DEFAULT_ORDER;
    return oa - ob;
  });
}
