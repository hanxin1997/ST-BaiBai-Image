import { getContext } from '@/st/context';

/**
 * 酒馆世界书的读写(仅常驻模式用)。
 *
 * 走 ST 前端的同款 API:
 * - POST /api/worldinfo/get    body { name }        → 书 JSON
 * - POST /api/worldinfo/edit   body { name, data }  → 保存
 * - POST /api/worldinfo/delete body { name }        → 删除
 *
 * 只声明用到的字段;其余元数据原样保留,不重建整个条目(避免把 ST 新字段抹掉)。
 */

export interface WorldInfoEntryRaw {
  uid?: number;
  key?: string[];
  keysecondary?: string[];
  comment?: string;
  content?: string;
  constant?: boolean;
  disable?: boolean;
  [k: string]: unknown;
}

export interface WorldInfoBook {
  entries: Record<string, WorldInfoEntryRaw>;
  [k: string]: unknown;
}

async function post(path: string, body: unknown): Promise<Response> {
  const ctx = getContext();
  if (!ctx) throw new Error('SillyTavern 上下文不可用');
  return fetch(path, {
    method: 'POST',
    headers: ctx.getRequestHeaders(),
    body: JSON.stringify(body),
  });
}

/** 读一本书;不存在返回 null。 */
export async function getWorldInfoBook(name: string): Promise<WorldInfoBook | null> {
  const resp = await post('/api/worldinfo/get', { name });
  if (!resp.ok) return null;
  const data = await resp.json().catch(() => null);
  if (!data || typeof data !== 'object') return null;
  const book = data as WorldInfoBook;
  if (!book.entries || typeof book.entries !== 'object') book.entries = {};
  return book;
}

/** 保存整本书。 */
export async function saveWorldInfoBook(name: string, data: WorldInfoBook): Promise<void> {
  const resp = await post('/api/worldinfo/edit', { name, data });
  if (!resp.ok) throw new Error(`保存世界书失败 (${resp.status})`);
}

/** 删除一本书;不存在当成功。 */
export async function deleteWorldInfoBook(name: string): Promise<void> {
  const resp = await post('/api/worldinfo/delete', { name });
  if (!resp.ok && resp.status !== 404) throw new Error(`删除世界书失败 (${resp.status})`);
}
