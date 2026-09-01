/**
 * 柏宝书角色状态读取与格式化。
 *
 * 画图场景只关心「角色特征对不对」,不关心剧情上下文:快照不再整个塞进提示词,
 * 只解析成**角色参考块**——主角档案 + 重要角色(常驻,与柏宝书注入端同款全量档)。
 * 其余角色用名字去目标正文里查:正文中出现才发送(柏宝书在场判定可能有滞后,
 * 角色已到场但记录未更新,以正文为准),同样发全量——因为它可能实际就在场。
 * 历史剧情、时间地点、物品、计划等与画面无关,一律不注入。
 */

interface BookFloor {
  revision: number;
  memory: { valid: boolean };
}

interface BookSnapshot {
  revision: number;
  [key: string]: unknown;
}

interface BookFloorContext {
  revision: number;
  floorData?: { memory?: { valid?: boolean } };
  snapshotBefore?: BookSnapshot;
  snapshotAfter?: BookSnapshot;
}

interface BookApi {
  apiVersion: number;
  getFloor(floor: number): BookFloor;
  getSnapshot(options: { floor: number; at: 'before' | 'after' }): BookSnapshot;
  getContextAtFloor?(options: { floor: number }): BookFloorContext;
}

/** 参考块中涉及的单个角色(结构化),供角色固定外貌 tag 库做锚定匹配。 */
export interface BookRole {
  /** 角色名:NPC 为柏宝书 name;主角为调用方给的名字(缺省「主角」)。 */
  name: string;
  /** 柏宝书记录的固定外貌原文(主角 appearance / NPC desc);未记录为空串。 */
  desc: string;
  isProtagonist: boolean;
}

export interface BookMemoryContext {
  timing: 'before_latest' | 'after_latest';
  /** 解析后的角色参考文本块,可直接拼进提示词。 */
  text: string;
  /** 本次参考块涉及的角色(与 text 同一批过滤口径)。 */
  roles: BookRole[];
}

function getBookApi(): BookApi | null {
  const api = (globalThis as { STBaiBaiBook?: BookApi }).STBaiBaiBook;
  return api?.apiVersion === 1 ? api : null;
}

/* ============ 快照 → 角色参考文本 ============ */

function oneLine(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function fmtProtagonist(protagonist: unknown): string {
  const p = (protagonist ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  const fields: Array<[string, string]> = [
    ['性别', 'gender'],
    ['年龄', 'age'],
    ['身份', 'identity'],
    ['外貌', 'appearance'],
    ['着装', 'outfit'],
    ['状态', 'condition'],
  ];
  for (const [label, key] of fields) {
    const v = oneLine(p[key]);
    if (v) parts.push(`${label}:${v}`);
  }
  return parts.join('；');
}

/**
 * NPC 全量行,对齐柏宝书注入端在场档的字段;画图场景额外带固定外貌 desc
 * (柏宝书对主要角色从简外貌是因为主模型卡里已有,画图对颜值敏感,外貌必须给)。
 */
function fmtNpc(n: Record<string, unknown>): string {
  const name = oneLine(n.name);
  const bracket = [oneLine(n.gender), oneLine(n.age), oneLine(n.title)].filter(Boolean).join('·');
  let line = bracket ? `${name}(${bracket})` : name;
  const rel = oneLine(n.relation);
  if (rel) line += ` —— 与主角:${rel}`;
  const tail: string[] = [];
  const desc = oneLine(n.desc);
  if (desc) tail.push(`外貌:${desc}`);
  const outfit = oneLine(n.outfit);
  if (outfit) tail.push(`着装:${outfit}`);
  const condition = oneLine(n.condition);
  if (condition) tail.push(`状态:${condition}`);
  if (n.follow === true) tail.push('随行');
  else {
    const loc = oneLine(n.location);
    if (loc) tail.push(`在:${loc}`);
  }
  return tail.length ? `${line} 〔${tail.join(';')}〕` : line;
}

function fmtNpcs(npcs: unknown, bodyText: string, roles: BookRole[]): string {
  if (!Array.isArray(npcs)) return '';
  const lines: string[] = [];
  for (const raw of npcs) {
    const n = (raw ?? {}) as Record<string, unknown>;
    const name = oneLine(n.name);
    if (!name) continue;
    // 重要角色常驻;随行角色永远在场;其余用名字去目标正文里查,出现才算参与本楼
    if (n.important === true || n.follow === true || bodyText.includes(name)) {
      lines.push(`- ${fmtNpc(n)}`);
      roles.push({ name, desc: oneLine(n.desc), isProtagonist: false });
    }
  }
  return lines.length ? `重要角色:\n${lines.join('\n')}` : '';
}

/** 把快照解析成角色参考文本 + 结构化角色列表(空角色信息 → 空串,调用方视为未提供)。 */
function formatSnapshotRoles(
  snapshot: BookSnapshot,
  bodyText: string,
  protagonistName: string,
): { text: string; roles: BookRole[] } {
  const lines: string[] = [];
  const roles: BookRole[] = [];
  const protagonist = fmtProtagonist(snapshot.protagonist);
  if (protagonist) {
    lines.push(`主角:${protagonist}`);
    const p = (snapshot.protagonist ?? {}) as Record<string, unknown>;
    roles.push({ name: protagonistName, desc: oneLine(p.appearance), isProtagonist: true });
  }
  const npcs = fmtNpcs(snapshot.npcs, bodyText, roles);
  if (npcs) lines.push(npcs);
  return { text: lines.join('\n'), roles };
}

/* ============ 文本包装 ============ */

const ROLE_NOTE = '【角色参考(柏宝书同步的最新状态,只读参考)】\n';

function buildMemoryText(roles: string): string {
  return `${ROLE_NOTE}${roles}`;
}

/* ============ 读取入口 ============ */

/**
 * 读取柏宝书角色状态并解析成角色参考文本。
 * @param floor 目标楼
 * @param bodyText 目标楼正文原文(用于判定不在场角色是否实际参与本楼)
 * @param protagonistName 主角显示名(一般传 user 名;缺省「主角」,仅作角色 tag 库的匹配键)
 * 柏宝书不可用 / 无角色信息 / 读取失败 → 返回 null(调用方降级为仅发送正文)。
 */
export function readBookMemory(
  floor: number,
  bodyText: string,
  protagonistName = '主角',
): BookMemoryContext | null {
  const api = getBookApi();
  if (!api) return null;
  try {
    let snapshot: BookSnapshot | undefined;
    let timing: BookMemoryContext['timing'] = 'before_latest';

    if (typeof api.getContextAtFloor === 'function') {
      // 优先走 getContextAtFloor:前后快照由柏宝书一次性对齐 revision,内部已保证一致。
      const data = api.getContextAtFloor({ floor });
      const valid = !!data.floorData?.memory?.valid;
      timing = valid ? 'after_latest' : 'before_latest';
      snapshot = valid ? data.snapshotAfter : data.snapshotBefore;
    } else {
      // 降级:旧版公共 API,按 D1/D2 规则逐次尝试对齐 revision
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const floorData = api.getFloor(floor);
        timing = floorData.memory.valid ? 'after_latest' : 'before_latest';
        const s = api.getSnapshot({
          floor,
          at: timing === 'after_latest' ? 'after' : 'before',
        });
        if (floorData.revision === s.revision) {
          snapshot = s;
          break;
        }
      }
      if (!snapshot) {
        console.warn('[柏宝绘] 柏宝书在读取期间持续变化，本次不附带角色参考');
        return null;
      }
    }
    if (!snapshot) return null;

    const { text, roles } = formatSnapshotRoles(snapshot, bodyText, protagonistName);
    if (!text) return null;
    return { timing, text: buildMemoryText(text), roles };
  } catch (error) {
    console.warn('[柏宝绘] 读取柏宝书角色状态失败，本次仅使用最近正文', error);
    return null;
  }
}
