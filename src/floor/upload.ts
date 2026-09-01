import { getContext } from '@/st/context';

/**
 * ST 文件存储（user/files）的上传/删除封装。
 *
 * 不依赖 ST 内部 uploadFileAttachment（chats.js:274 未暴露给第三方扩展，
 * 且失败时吞错返回 undefined 并弹 toastr）——这里用完全等价的
 * POST /api/files/upload 自实现，可拿到状态码与响应体，错误由调用方呈现。
 */

export class FileStoreError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'FileStoreError';
  }
}

async function postFile(endpoint: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; text: string }> {
  const ctx = getContext();
  if (!ctx) throw new FileStoreError('SillyTavern 上下文不可用');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: ctx.getRequestHeaders(),
    body: JSON.stringify(body),
  });
  const text = await response.text().catch(() => '');
  return { ok: response.ok, status: response.status, text };
}

/** 上传 base64 文件，返回可访问的相对路径（/user/files/...）。失败抛错。 */
export async function uploadBase64File(name: string, base64: string): Promise<string> {
  const { ok, status, text } = await postFile('/api/files/upload', { name, data: base64 });
  if (!ok) {
    throw new FileStoreError(`文件上传失败 (${status})${text ? `：${text.slice(0, 300)}` : ''}`, status);
  }
  let path = '';
  try {
    const parsed = JSON.parse(text) as { path?: unknown };
    if (typeof parsed.path === 'string') path = parsed.path;
  } catch {
    /* 响应不是 JSON，落到下方统一报错 */
  }
  if (!path) throw new FileStoreError('文件上传失败：服务端未返回路径');
  return path;
}

/** 上传图片。 */
export function uploadImageFile(name: string, base64: string): Promise<string> {
  return uploadBase64File(name, base64);
}

/** 删除已上传文件。返回 false 表示文件本就不存在（无需清理）。 */
export async function deleteUploadedFile(path: string): Promise<boolean> {
  const { ok, status, text } = await postFile('/api/files/delete', { path });
  if (ok) return true;
  if (status === 404) return false;
  throw new FileStoreError(`文件删除失败 (${status})${text ? `：${text.slice(0, 300)}` : ''}`, status);
}

/** 删除已上传图片。 */
export function deleteImageFile(path: string): Promise<boolean> {
  return deleteUploadedFile(path);
}
