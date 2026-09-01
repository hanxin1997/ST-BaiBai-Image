/**
 * 不依赖 Web Crypto 的 UUID v4:ST 常在非安全上下文(http)下运行,
 * 那里 crypto.randomUUID 会直接抛错,而 vibe 缓存键/文件名的随机段
 * 只是防撞,不需要密码学强度——Math.random 足够。
 */
export function randomUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
    const value = Math.floor(Math.random() * 16);
    return (char === 'x' ? value : (value & 0x3) | 0x8).toString(16);
  });
}
