/**
 * 限并发的 map。图库按批发 HEAD 探体积、批量删图时都要用:
 * 一个角色目录几十张图,`Promise.all` 一把梭会把几十个请求同时压给 ST,
 * 公网连接下先把自己的聊天卡住。
 */

/**
 * 并发不超过 limit 地映射,**返回顺序与输入一致**(不是完成顺序)。
 *
 * `fn` 抛出会让整体 reject(标准 Promise.all 语义),但已启动的其余任务不会被叫停——
 * 故批量删除这类「要容忍单条失败」的场景,请在 `fn` 内部自行 try/catch 并返回结果对象,
 * 不要依赖本函数做部分失败处理。
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (!items.length) return results;
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let cursor = 0;
  // 每个 worker 自取下一个未领的下标:比切片分组更均衡(慢任务不会拖住整片)
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
