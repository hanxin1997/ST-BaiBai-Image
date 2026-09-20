import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

import { deleteUserImage, ImageStoreError, probeUserImage, uploadUserImage } from '@/st/images';

function fakeContext() {
  return { getRequestHeaders: () => ({ 'X-Test': '1' }) };
}

describe('uploadUserImage', () => {
  beforeEach(() => {
    mocks.context = fakeContext();
  });

  it('按 /api/images/upload 协议提交(folder → ch_name),返回落盘路径', async () => {
    const fetchMock = vi.fn((url: string, init: any) => {
      expect(url).toBe('/api/images/upload');
      const body = JSON.parse(init.body);
      expect(body).toEqual({
        image: 'QUJD',
        format: 'jpg',
        ch_name: '柏宝绘_画师串',
        filename: 'art_1',
      });
      return Promise.resolve(
        new Response(JSON.stringify({ path: '/user/images/柏宝绘_画师串/art_1.jpg' }), {
          status: 200,
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const path = await uploadUserImage('柏宝绘_画师串', 'art_1', 'QUJD', 'jpg');
    expect(path).toBe('/user/images/柏宝绘_画师串/art_1.jpg');
  });

  it('服务端报错 → ImageStoreError 带状态码', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{"error":"bad"}', { status: 400 }))),
    );
    await expect(uploadUserImage('f', 'n', 'QUJD', 'jpg')).rejects.toMatchObject({
      name: 'ImageStoreError',
      status: 400,
    });
  });

  it('200 但响应缺 path → 报错(不让调用方拿到空路径存进设置)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))));
    await expect(uploadUserImage('f', 'n', 'QUJD', 'jpg')).rejects.toBeInstanceOf(
      ImageStoreError,
    );
  });

  it('上下文不可用 → 直接抛,不发请求', async () => {
    mocks.context = null;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(uploadUserImage('f', 'n', 'QUJD', 'jpg')).rejects.toBeInstanceOf(
      ImageStoreError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('deleteUserImage', () => {
  beforeEach(() => {
    mocks.context = fakeContext();
  });

  it('删除成功 → true;404 → false(文件本就不存在,无需清理)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        expect(url).toBe('/api/images/delete');
        return Promise.resolve(new Response('{}', { status: 200 }));
      }),
    );
    await expect(deleteUserImage('/user/images/f/a.jpg')).resolves.toBe(true);

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('File not found', { status: 404 }))),
    );
    await expect(deleteUserImage('/user/images/f/a.jpg')).resolves.toBe(false);
  });

  it('其它失败 → ImageStoreError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('oops', { status: 500 }))),
    );
    await expect(deleteUserImage('/user/images/f/a.jpg')).rejects.toMatchObject({
      name: 'ImageStoreError',
      status: 500,
    });
  });
});

describe('probeUserImage', () => {
  beforeEach(() => {
    mocks.context = fakeContext();
  });

  it('HEAD 取 Content-Length,不下载图片本身', async () => {
    const fetchMock = vi.fn((url: string, init: any) => {
      expect(url).toBe('/user/images/f/a.jpg');
      expect(init.method).toBe('HEAD');
      return Promise.resolve(new Response(null, { status: 200, headers: { 'content-length': '311300' } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(probeUserImage('/user/images/f/a.jpg')).resolves.toEqual({ exists: true, size: 311300 });
  });

  it('404 → exists:false(服务端明确说没有)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))));
    await expect(probeUserImage('/user/images/f/a.jpg')).resolves.toEqual({ exists: false });
  });

  it('网络错误/5xx → null:分不清,绝不能当成「已删除」', async () => {
    // 把一次掉线记成删除,会让用户网一抖就看见满屏「文件已删除」
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(probeUserImage('/user/images/f/a.jpg')).resolves.toBeNull();

    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 500 }))));
    await expect(probeUserImage('/user/images/f/a.jpg')).resolves.toBeNull();
  });

  it('缺 Content-Length 仍算存在,size 为 null', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))));
    await expect(probeUserImage('/user/images/f/a.jpg')).resolves.toEqual({ exists: true, size: null });
  });

  it('超时中止 → null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: any) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
      ),
    );
    await expect(probeUserImage('/user/images/f/a.jpg', 1)).resolves.toBeNull();
  });
});
