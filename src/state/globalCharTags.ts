import { getContext } from '@/st/context';
import { reactive } from 'vue';
import {
  findCharTag,
  normalizeCharTagStore,
  recomputeCharTags,
  removeCharTag,
  setGlobalCharTagSource,
  upsertCharTag,
  type CharTagEntry,
} from '@/state/charTags';

/**
 * 全局角色固定外貌库 —— 跨所有聊天生效的「只读模板」。
 *
 * 定位:玩家角色等「哪个聊天都用同一张脸」的角色,建档一次、处处生效。
 * 硬约束:**AI 永远不能写它**(charTags.applyCharTagOps 按锁定名丢弃 changes),
 * 只有用户手动增删改、或把本聊天角色「提升为全局」会写。tag 有问题用户自己改。
 *
 * 存储:extensionSettings[GLOBAL_KEY](→ 服务器 settings.json,跨设备同步),
 * 带 revision + 广播事件,协议与 settings.ts 的共享渠道/排除名单同构。
 * 条目结构复用 CharTagEntry,但**不记 history**(跨聊天没有楼层概念,也没有可回滚的 AI 变更)。
 *
 * 依赖方向:本模块 → charTags(normalize/CRUD/重算);charTags → 本模块只经
 * setGlobalCharTagSource 注入的只读 getter,不成模块环。
 */

const GLOBAL_KEY = 'baibai_image_char_global';
const GLOBAL_EVENT = 'st-baibai-image:char-global-changed';
const SCHEMA_VERSION = 1;

interface GlobalCharTagStore {
  schemaVersion: number;
  revision: number;
  entries: CharTagEntry[];
}

export const globalCharTagLib = reactive<{ entries: CharTagEntry[] }>({ entries: [] });
let fingerprint = '';
let revision = 0;
let listenerBound = false;

function fingerprintOf(entries: CharTagEntry[]): string {
  return JSON.stringify(entries);
}

/** 全局条目一律不带 history(没有可回滚的自动变更,手动编辑也不留痕,保持简单)。 */
function normalizeGlobalEntries(raw: unknown): CharTagEntry[] {
  return normalizeCharTagStore(raw).map(entry => ({ ...entry, history: [] }));
}

function readStore(raw: unknown): GlobalCharTagStore | null {
  if (!raw || typeof raw !== 'object') return null;
  const store = raw as Partial<GlobalCharTagStore>;
  if (!Array.isArray(store.entries)) return null;
  return {
    schemaVersion: SCHEMA_VERSION,
    revision:
      typeof store.revision === 'number' && Number.isFinite(store.revision)
        ? Math.max(0, Math.floor(store.revision))
        : 0,
    entries: normalizeGlobalEntries({ version: 3, entries: store.entries }),
  };
}

function persist(): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  revision += 1;
  const store: GlobalCharTagStore = {
    schemaVersion: SCHEMA_VERSION,
    revision,
    entries: JSON.parse(JSON.stringify(globalCharTagLib.entries)) as CharTagEntry[],
  };
  ctx.extensionSettings[GLOBAL_KEY] = store;
  fingerprint = fingerprintOf(store.entries);
  ctx.saveSettingsDebounced?.();
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(
      new CustomEvent(GLOBAL_EVENT, {
        detail: { revision: store.revision, source: 'ST-BaiBai-Image' },
      }),
    );
  }
}

function applyStore(store: GlobalCharTagStore): void {
  const next = fingerprintOf(store.entries);
  revision = Math.max(revision, store.revision);
  if (next === fingerprint) return;
  globalCharTagLib.entries = store.entries;
  fingerprint = next;
  // 派生库(合并种子 + 锁定名)随全局库变化即时刷新
  recomputeCharTags();
}

function bindListener(): void {
  if (listenerBound) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  listenerBound = true;
  window.addEventListener(GLOBAL_EVENT, () => {
    const ctx = getContext();
    const store = readStore(ctx?.extensionSettings?.[GLOBAL_KEY]);
    if (store) applyStore(store);
  });
}

/**
 * 启动初始化:注入条目来源(必须在 bindCharTagSync 之前,首次重算就要带上全局库),
 * 再从 extensionSettings 领养已有数据并挂上广播监听。
 */
export function initGlobalCharTags(): void {
  setGlobalCharTagSource(() => globalCharTagLib.entries);
  const ctx = getContext();
  if (ctx?.extensionSettings) {
    const store = readStore(ctx.extensionSettings[GLOBAL_KEY]);
    if (store) applyStore(store);
  }
  bindListener();
}

export function findGlobalCharTag(name: string): CharTagEntry | undefined {
  const clean = name.trim();
  return globalCharTagLib.entries.find(entry => entry.name === clean);
}

/** 新增/覆盖全局条目(仅用户手动路径调用;oldName 用于改名)。 */
export function upsertGlobalCharTag(entry: CharTagEntry, oldName?: string): boolean {
  const name = entry.name.trim();
  const [normalized] = normalizeGlobalEntries({ version: 3, entries: [{ ...entry, name }] });
  if (!normalized) return false;
  if (oldName && oldName !== name) {
    const oldIndex = globalCharTagLib.entries.findIndex(candidate => candidate.name === oldName);
    if (oldIndex >= 0) globalCharTagLib.entries.splice(oldIndex, 1);
  }
  const index = globalCharTagLib.entries.findIndex(candidate => candidate.name === name);
  if (index >= 0) globalCharTagLib.entries[index] = normalized;
  else globalCharTagLib.entries.push(normalized);
  persist();
  recomputeCharTags();
  return true;
}

export function removeGlobalCharTag(name: string): boolean {
  const clean = name.trim();
  const index = globalCharTagLib.entries.findIndex(entry => entry.name === clean);
  if (index < 0) return false;
  globalCharTagLib.entries.splice(index, 1);
  persist();
  recomputeCharTags();
  return true;
}

/**
 * 把本聊天角色的**当前生效值**(含本聊天 AI 已改出的结果)快照进全局库,
 * 并删除本聊天副本、清掉该角色在本聊天的楼层 ops —— 之后由全局库接管,
 * 任何聊天(包括本聊天)都以全局值为准,AI 的 changes 对该名字一律无效。
 */
export function promoteCharTagToGlobal(name: string): boolean {
  const current = findCharTag(name);
  if (!current) return false;
  if (!upsertGlobalCharTag({ ...current, fields: { ...current.fields }, history: [] })) return false;
  removeCharTag(name);
  return true;
}

/**
 * 反向出口:把全局条目复制成本聊天副本。之后本聊天以副本为准(覆盖全局),
 * 该名字移出锁定集,AI 在本聊天可照常对它变更;其他聊天不受影响。
 */
export function copyGlobalCharTagToChat(name: string): boolean {
  const global = findGlobalCharTag(name);
  if (!global) return false;
  return upsertCharTag(
    { ...global, fields: { ...global.fields }, history: [] },
    undefined,
    { recordChanges: false },
  );
}
