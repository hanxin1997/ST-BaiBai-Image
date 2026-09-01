import { describe, expect, it } from 'vitest';

import { SlotRegistry } from '@/floor/registry';

describe('SlotRegistry', () => {
  it('builds a unique key from chat/mesid/swipeId/seq', () => {
    const registry = new SlotRegistry();
    const chat = 'chat-12';
    expect(registry.key(chat, 3, 0, 0)).toBe('chat-12|3|0|0');
    expect(registry.key(chat, 3, 0, 1)).not.toBe(registry.key(chat, 3, 0, 0));
    // 同一楼层不同 swipe 互不冲突
    expect(registry.key(chat, 3, 1, 0)).not.toBe(registry.key(chat, 3, 0, 0));
    // chatId 缺失时用占位符，仍保持 key 形状
    expect(registry.key(undefined, 3, 0, 0)).toBe('-|3|0|0');
  });

  it('stores and retrieves records', () => {
    const registry = new SlotRegistry();
    const record = { container: {} as ShadowRoot, vnode: {} as never };
    const key = registry.key('c', 1, 0, 0);
    expect(registry.has(key)).toBe(false);
    registry.set(key, record);
    expect(registry.has(key)).toBe(true);
    expect(registry.get(key)).toBe(record);
    registry.delete(key);
    expect(registry.has(key)).toBe(false);
  });

  it('lists all keys of a message across swipes', () => {
    const registry = new SlotRegistry();
    const chat = 'c';
    registry.set(registry.key(chat, 1, 0, 0), { container: {} as ShadowRoot, vnode: {} as never });
    registry.set(registry.key(chat, 1, 1, 0), { container: {} as ShadowRoot, vnode: {} as never });
    registry.set(registry.key(chat, 2, 0, 0), { container: {} as ShadowRoot, vnode: {} as never });
    registry.set(registry.key('other', 1, 0, 0), { container: {} as ShadowRoot, vnode: {} as never });

    const keys = registry.keysByMessage(chat, 1).sort();
    expect(keys).toEqual(['c|1|0|0', 'c|1|1|0']);
    expect(registry.size).toBe(4);

    registry.clear();
    expect(registry.size).toBe(0);
  });
});
