/**
 * 字节数 → 人读体积。图库的分组体积与总计共用这一个口径。
 *
 * 用 1024 进制、单位写 KB/MB(而非 KiB/MiB):与资源管理器/Finder 的显示习惯一致,
 * 用户拿图库数字和系统里看到的对比时不会差一截。
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * 格式化为 `624 KB` / `1.5 MB` / `11 MB` 这样的短串。
 *
 * 小数位按量级给:不足 10 的留一位(1.5 MB 比 2 MB 有信息量),10 以上抹掉
 * (11.2 MB 的那个 .2 在角标里只是噪声)。字节本身不给小数。
 *
 * 非有限值/负数返回空串,让调用方自己决定显示什么——这里凭空编个 `0 B`
 * 会把「还没算出来」伪装成「算出来是空的」。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const decimals = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(decimals)} ${UNITS[unit]}`;
}
