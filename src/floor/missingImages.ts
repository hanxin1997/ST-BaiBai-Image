import { reactive } from 'vue';

import { probeUserImage } from '@/st/images';

/**
 * 「文件已不在」的图片路径册(模块级、会话内有效)。
 *
 * 为什么需要它:图库现在能直接删 user/images 下的文件,但那张图的指针还躺在某个聊天的
 * `message.extra.bbiImage` 里——图库按**目录**列图,指针在**某个聊天**里,两者之间没有反向
 * 索引,而扫全库反查不可行(实测单用户 chats 目录 7 GB / 1243 个 jsonl,且 /api/chats/get
 * 无分页)。所以删文件必然留下破指针,卡片侧只能靠「运行时发现它 404」来降级。
 *
 * 为什么必须放组件外:与 collapseState.ts / genState.ts 同理——卡片的生命周期由水合决定,
 * 任一兄弟槽位出图都会重建整楼卡片,标记若存在组件 ref 里,重建后破图会原地复活。
 *
 * 为什么不写回 extra:那需要 saveChat() 落盘,而「文件没了」是磁盘的客观状态,不是聊天数据;
 * 且用户完全可能把文件恢复回来。会话内记住即可,刷新后由 <img> 的 @error 重新发现。
 */

/** 归一化后的路径集合。reactive 让卡片的 computed 能跟着它重算。 */
const missing = reactive(new Set<string>());

/**
 * 归一化图片路径,给「extra 里的 path」与「图库拼出来的 src」找一个能相等的写法。
 * **本册读写两侧、以及图库的提示词缓存键,共用这一个口径**——两套写法不对账,
 * 图库删完图卡片照样显示破图。
 *
 * 两边天生不一样:extra 里的 entry.path 是服务端 clientRelativePath 原样返回的**未编码**
 * 中文路径,而图库的 src 是逐段 encodeURIComponent 过的;前导斜杠也有无不定
 * (storage.ts 删除分支的 `/^\/?user\/images\//` 就是为此写的)。统一解码 + 去前导斜杠后再比。
 */
export function normalizeImagePath(path: string): string {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    /* 半截百分号编码:解不开就按原文比,总好过抛错 */
  }
  return decoded.replace(/^\/+/, '');
}

/** 记下这张图的文件已经没了(调用方须先确认确实是 404,别把网络抖动记成删除)。 */
export function markImageMissing(path: string): void {
  if (path) missing.add(normalizeImagePath(path));
}

/** 批量版本(图库一次删多张)。 */
export function markImagesMissing(paths: Iterable<string>): void {
  for (const path of paths) markImageMissing(path);
}

export function isImageMissing(path: string): boolean {
  return !!path && missing.has(normalizeImagePath(path));
}

/** 正在确认的路径:同一张图的多次 error 只探一次(重水合会重挂 <img>,error 会再来)。 */
const probing = new Set<string>();

/**
 * `<img>` 报 error 后调用:**先确认真是 404 再标记**。
 *
 * 不能一 error 就标记缺失——`<img>` 的 error 分不清「文件没了」和「网断了/服务端 500」,
 * 把掉线记成删除,用户网一抖就会看见满屏「文件已删除」,而且刷新前好不了。
 * 故这里补一次 HEAD:只有服务端明确说 404 才落册,分不清(probe 返回 null)就什么都不做,
 * 让浏览器的破图占位留着,下次重挂时自然重试。
 *
 * 只认 user/images 下的图:user/files 里的老图本插件不删,没有「被图库删掉」这条路径。
 */
export async function confirmImageMissing(path: string): Promise<boolean> {
  if (!path || !/^\/?user\/images\//.test(normalizeImagePath(path))) return false;
  const key = normalizeImagePath(path);
  if (missing.has(key)) return true;
  if (probing.has(key)) return false;
  probing.add(key);
  try {
    const probe = await probeUserImage(path);
    // null = 分不清,绝不落册
    if (probe && !probe.exists) {
      missing.add(key);
      return true;
    }
    return false;
  } finally {
    probing.delete(key);
  }
}

/** 仅供测试:清空本册。 */
export function resetMissingImages(): void {
  missing.clear();
  probing.clear();
}
