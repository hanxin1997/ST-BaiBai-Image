import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  appendEntry,
  BBI_IMAGE_EXTRA_KEY,
  deleteImageResult,
  generationId,
  historyEntries,
  imageFileName,
  latestEntry,
  latestStaleEntry,
  mutateStore,
  prepareImageForStorage,
  promptHash,
  readStore,
  saveImageResult,
  type BbiImageEntry,
} from '@/floor/storage';
import type { STContext, STMessage } from '@/st/context';
import { settings } from '@/state/settings';

function fakeEntry(overrides: Partial<BbiImageEntry> = {}): BbiImageEntry {
  return {
    generationId: 'g1',
    path: '/user/files/bbi_x.png',
    prompt: '<bbi_image>a</bbi_image>',
    seed: null,
    status: 'ready',
    createdAt: 1000,
    ...overrides,
  };
}

function fakeMessage(): STMessage {
  return { name: 'c', is_user: false, is_system: false, mes: 'x' };
}

function fakeCtx(message: STMessage, saveChat = vi.fn(async () => undefined)): STContext {
  return { chat: [message], saveChat } as unknown as STContext;
}

afterEach(() => vi.unstubAllGlobals());

describe('promptHash', () => {
  it('is deterministic and 14 hex chars', () => {
    const tag = '<bbi_image>1girl, moonlight</bbi_image>';
    expect(promptHash(tag)).toBe(promptHash(tag));
    expect(promptHash(tag)).toMatch(/^[0-9a-f]{14}$/);
  });

  it('distinguishes different prompts', () => {
    expect(promptHash('<bbi_image>a</bbi_image>')).not.toBe(
      promptHash('<bbi_image>b</bbi_image>'),
    );
    // 编辑提示词内容 → hash 变化（stale 检测的根基）
    expect(promptHash('<bbi_image>1girl, cat</bbi_image>')).not.toBe(
      promptHash('<bbi_image>1girl, dog</bbi_image>'),
    );
  });
});

describe('imageFileName', () => {
  it('uses a stable character-name hash in the flat filename', () => {
    expect(imageFileName('\u67cf\u5b9d', 0, 'a3f9c2', 'g_1723', 'png')).toBe(
      `bbi_${promptHash('\u67cf\u5b9d')}_0_a3f9c2-g_1723.png`,
    );
  });

  it('does not expose unsupported characters from the character name', () => {
    expect(imageFileName('\u67cf\u5b9d/\u6d4b\u8bd5 \u5361', 1, 'h', 'g', 'png')).toMatch(
      /^bbi_[0-9a-f]{14}_1_h-g\.png$/,
    );
  });
});

describe('store read helpers', () => {
  it('reads latest entry by swipe + hash and ignores other swipes', () => {
    const store = appendEntry({}, 0, 'h1', fakeEntry({ generationId: 'a', createdAt: 1, slotSeq: 0 }));
    const store2 = appendEntry(store, 0, 'h1', fakeEntry({ generationId: 'b', createdAt: 2, slotSeq: 0 }));
    const store3 = appendEntry(store2, 1, 'h1', fakeEntry({ generationId: 'c', slotSeq: 0 }));

    expect(latestEntry(store3, 0, 'h1', 0)?.generationId).toBe('b');
    expect(latestEntry(store3, 1, 'h1', 0)?.generationId).toBe('c');
    expect(latestEntry(store3, 0, 'other-hash', 0)).toBeNull();
  });

  it('isolates results by slot: same-hash entries of different slots stay separate', () => {
    // 同一楼层两个 tag 内容相同（同 hash）→ 各自槽位独立取图，不串
    const store = appendEntry({}, 0, 'h', fakeEntry({ generationId: 'slot0', slotSeq: 0, createdAt: 1 }));
    const store2 = appendEntry(store, 0, 'h', fakeEntry({ generationId: 'slot1', slotSeq: 1, createdAt: 2 }));
    const store3 = appendEntry(store2, 0, 'h', fakeEntry({ generationId: 'slot0-again', slotSeq: 0, createdAt: 3 }));

    expect(latestEntry(store3, 0, 'h', 0)?.generationId).toBe('slot0-again');
    expect(latestEntry(store3, 0, 'h', 1)?.generationId).toBe('slot1');
  });

  it('falls back to slot 0 for legacy entries without slotSeq', () => {
    const store = appendEntry({}, 0, 'h', fakeEntry({ generationId: 'legacy' }));
    expect(latestEntry(store, 0, 'h', 0)?.generationId).toBe('legacy');
    expect(latestEntry(store, 0, 'h', 1)).toBeNull();
  });

  it('historyEntries returns same-slot history in time order for paging', () => {
    const store = appendEntry({}, 0, 'h', fakeEntry({ generationId: 'first', slotSeq: 0, createdAt: 1 }));
    const store2 = appendEntry(store, 0, 'h', fakeEntry({ generationId: 'second', slotSeq: 0, createdAt: 2 }));
    const store3 = appendEntry(store2, 0, 'h', fakeEntry({ generationId: 'other-slot', slotSeq: 1, createdAt: 3 }));
    const store4 = appendEntry(store3, 0, 'other-hash', fakeEntry({ generationId: 'other-hash', slotSeq: 0 }));

    expect(historyEntries(store4, 0, 'h', 0).map(e => e.generationId)).toEqual(['first', 'second']);
    expect(historyEntries(store4, 0, 'h', 1).map(e => e.generationId)).toEqual(['other-slot']);
    expect(historyEntries(store4, 0, 'h', 2)).toEqual([]);
    expect(historyEntries(null, 0, 'h', 0)).toEqual([]);
  });

  it('finds the newest stale entry from other prompt hashes in the same slot only', () => {
    const store = appendEntry({}, 0, 'old1', fakeEntry({ generationId: 'a', createdAt: 5, slotSeq: 0 }));
    const store2 = appendEntry(store, 0, 'old2', fakeEntry({ generationId: 'b', createdAt: 9, slotSeq: 0 }));
    const store3 = appendEntry(store2, 0, 'current', fakeEntry({ generationId: 'c', createdAt: 1, slotSeq: 0 }));

    expect(latestStaleEntry(store3, 0, 'current', 0)?.generationId).toBe('b');
    // 排除自身键后返回其它键中最新的一条（old1 的 a 比 current 的 c 新）
    expect(latestStaleEntry(store3, 0, 'old2', 0)?.generationId).toBe('a');
    expect(latestStaleEntry(null, 0, 'x', 0)).toBeNull();
    expect(latestStaleEntry(store3, 9, 'x', 0)).toBeNull();
  });

  it('never reports a neighbor slot result as stale (multi-tag floor bug)', () => {
    // 卡片 1 生成过（槽位 0），卡片 2（槽位 1）从未生成 → 卡片 2 必须 pending，
    // 不得把卡片 1 的图当 stale 显示
    const store = appendEntry({}, 0, 'hash-of-tag1', fakeEntry({ generationId: 'tag1-img', slotSeq: 0 }));
    expect(latestEntry(store, 0, 'hash-of-tag2', 1)).toBeNull();
    expect(latestStaleEntry(store, 0, 'hash-of-tag2', 1)).toBeNull();
    // 但同槽位换提示词后，旧图仍可作 stale 显示
    expect(latestStaleEntry(store, 0, 'hash-of-tag1-edited', 0)?.generationId).toBe('tag1-img');
  });

  it('readStore tolerates missing extra', () => {
    expect(readStore(fakeMessage())).toBeNull();
    const message = fakeMessage();
    message.extra = { [BBI_IMAGE_EXTRA_KEY]: { '0': {} } };
    expect(readStore(message)).toEqual({ '0': {} });
  });
});

describe('mutateStore (CAS)', () => {
  it('creates the store on first write and persists via saveChat', async () => {
    const message = fakeMessage();
    const saveChat = vi.fn(async () => undefined);
    const ctx = fakeCtx(message, saveChat);

    const ok = await mutateStore(ctx, 0, store => appendEntry(store, 0, 'h', fakeEntry()));
    expect(ok).toBe(true);
    expect(message.extra?.[BBI_IMAGE_EXTRA_KEY]).toBeTruthy();
    expect(latestEntry(readStore(message), 0, 'h', 0)).not.toBeNull();
    expect(saveChat).toHaveBeenCalledTimes(1);
  });

  it('retries when the store reference was replaced concurrently', async () => {
    const message = fakeMessage();
    const ctx = fakeCtx(message);
    let calls = 0;
    const ok = await mutateStore(ctx, 0, store => {
      calls += 1;
      if (calls === 1) {
        // 模拟另一个任务抢先整体替换了 store 引用
        message.extra![BBI_IMAGE_EXTRA_KEY] = {};
      }
      return appendEntry(store, 0, 'h', fakeEntry({ generationId: `g${calls}` }));
    });

    expect(ok).toBe(true);
    expect(calls).toBe(2);
    // 基于最新引用的第二次写入生效
    expect(latestEntry(readStore(message), 0, 'h', 0)?.generationId).toBe('g2');
  });

  it('returns false when the message no longer exists', async () => {
    const message = fakeMessage();
    const ctx = { chat: [message], saveChat: vi.fn(async () => undefined) } as unknown as STContext;
    expect(await mutateStore(ctx, 5, store => store)).toBe(false);
  });
});

describe('prepareImageForStorage', () => {
  const pngResult = { url: 'data:image/png;base64,AAAA', filename: 'x.png', format: 'png', revoke() {} };

  afterEach(() => {
    settings.storage.saveAsJpeg = false;
  });

  it('keeps the original format when the switch is off', async () => {
    settings.storage.saveAsJpeg = false;
    const out = await prepareImageForStorage(pngResult);
    expect(out.format).toBe('png');
    expect(out.base64).toBe('AAAA');
  });

  it('reencodes to jpg when the switch is on', async () => {
    settings.storage.saveAsJpeg = true;
    const jpegBlob = new Blob(['jpeg-bytes'], { type: 'image/jpeg' });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => {
      return { width: 2, height: 2, close: vi.fn() };
    }));
    const toBlob = vi.fn((cb: (b: Blob | null) => void, _type: string, _q: number) => {
      cb(jpegBlob);
    });
    const ctx2d = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() };
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ctx2d,
        toBlob,
      }),
    });
    // 浏览器 FileReader.readAsDataURL 返回带 MIME 前缀的完整 Data URL
    vi.stubGlobal('FileReader', class {
      result: string | ArrayBuffer | null = null;
      onload: (() => void) | null = null;
      readAsDataURL() {
        this.result = 'data:image/jpeg;base64,jpegb64';
        this.onload?.();
      }
    });

    const out = await prepareImageForStorage(pngResult);
    expect(out.format).toBe('jpg');
    expect(out.base64).toBe('jpegb64');
    expect(createImageBitmap).toHaveBeenCalled();
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.9);
    settings.storage.saveAsJpeg = false;
  });

  it('falls back to the original format when reencode fails', async () => {
    settings.storage.saveAsJpeg = true;
    // createImageBitmap 抛错 → 应回退 PNG 原样落盘
    vi.stubGlobal('createImageBitmap', vi.fn(async () => {
      throw new Error('decode failed');
    }));
    const out = await prepareImageForStorage(pngResult);
    expect(out.format).toBe('png');
    expect(out.base64).toBe('AAAA');
    settings.storage.saveAsJpeg = false;
  });
});

describe('saveImageResult', () => {
  it('records the actual seed used into the entry', async () => {
    const message = fakeMessage();
    const saveChat = vi.fn(async () => undefined);
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/files/upload') {
        return Promise.resolve(new Response(JSON.stringify({ path: '/user/files/bbi_seeded.png' }), { status: 200 }));
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
    vi.stubGlobal('window', {
      SillyTavern: {
        getContext: () => ({
          chat: [message],
          saveChat,
          getRequestHeaders: () => ({}),
          getCurrentChatId: () => 'chat-a',
        }),
      },
    });

    const result = { url: 'data:image/png;base64,AAAA', filename: 'x.png', format: 'png', revoke() {} };
    const entry = await saveImageResult(0, 0, 0, '<bbi_image>a</bbi_image>', 987654321, result);

    expect(entry.seed).toBe(987654321);
    // 落盘后 extra 可读回同一 entry
    expect(latestEntry(readStore(message), 0, promptHash('<bbi_image>a</bbi_image>'), 0)?.seed).toBe(987654321);
  });
});

describe('deleteImageResult', () => {
  it('removes the entry and deletes the file after save', async () => {
    const message = fakeMessage();
    const saveChat = vi.fn(async () => undefined);
    const store = appendEntry({}, 0, 'h', fakeEntry({ generationId: 'g1', path: '/user/files/bbi_a.png' }));
    const store2 = appendEntry(store, 0, 'h', fakeEntry({ generationId: 'g2', path: '/user/files/bbi_b.png' }));
    message.extra = { [BBI_IMAGE_EXTRA_KEY]: store2 };

    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/files/delete') return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      throw new Error(`unexpected fetch ${url}`);
    }));
    vi.stubGlobal('window', {
      SillyTavern: {
        getContext: () => ({
          chat: [message],
          saveChat,
          getRequestHeaders: () => ({}),
          getCurrentChatId: () => 'chat-a',
        }),
      },
    });

    const removed = await deleteImageResult(0, 0, 'h', 'g1');
    expect(removed).toBe(true);
    // g1 已被移除，g2 保留
    const entries = message.extra?.[BBI_IMAGE_EXTRA_KEY] as Record<string, Record<string, BbiImageEntry[]>>;
    expect(entries['0']['h'].map(e => e.generationId)).toEqual(['g2']);
  });
});
