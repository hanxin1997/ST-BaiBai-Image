import { getContext } from '@/st/context';
import { readStore, type BbiImageEntry } from '@/floor/storage';

/**
 * 图库图片数据结构。
 */
export interface GalleryImage {
  /** 图片路径 /user/files/bbi_... */
  path: string;
  /** 完整提示词原文（含 <bbi_image> 壳） */
  prompt: string;
  /** 生成种子 */
  seed: number | null;
  /** 生成时间戳 */
  createdAt: number;
  /** 生成唯一 ID（用于选择集合的键） */
  generationId: string;
  /** 所在消息索引 */
  mesid: number;
  /** swipe 索引 */
  swipeId: number;
  /** 角色名（msg.name） */
  characterName: string;
}

/**
 * 从当前聊天收集全部已生成图片。
 * 遍历 ctx.chat 的全部消息，提取 extra.bbiImage 中的图片元数据。
 */
export function collectAllImages(): GalleryImage[] {
  const ctx = getContext();
  if (!ctx || !Array.isArray(ctx.chat)) return [];

  const images: GalleryImage[] = [];

  ctx.chat.forEach((msg, mesid) => {
    const store = readStore(msg);
    if (!store) return;

    const swipeId = msg.swipe_id ?? 0;
    const bucket = store[String(swipeId)];
    if (!bucket) return;

    Object.values(bucket).forEach(entries => {
      if (!Array.isArray(entries)) return;
      entries.forEach((entry: BbiImageEntry) => {
        if (entry.status !== 'ready') return; // 只显示成功的图片
        images.push({
          path: entry.path,
          prompt: entry.prompt,
          seed: entry.seed,
          createdAt: entry.createdAt,
          generationId: entry.generationId,
          mesid,
          swipeId,
          characterName: msg.name || '未知',
        });
      });
    });
  });

  return images;
}

/**
 * 提取全部角色名（去重排序）。
 */
export function extractCharacters(images: GalleryImage[]): string[] {
  const chars = new Set<string>();
  images.forEach(img => chars.add(img.characterName));
  return Array.from(chars).sort();
}

/**
 * 按角色筛选。
 */
export function filterByCharacter(images: GalleryImage[], character: string | null): GalleryImage[] {
  if (!character) return images;
  return images.filter(img => img.characterName === character);
}

/**
 * 按提示词搜索（大小写不敏感）。
 */
export function filterBySearch(images: GalleryImage[], query: string): GalleryImage[] {
  const q = query.trim().toLowerCase();
  if (!q) return images;
  return images.filter(img => img.prompt.toLowerCase().includes(q));
}

/**
 * 按时间排序。
 */
export function sortByTime(images: GalleryImage[], order: 'desc' | 'asc'): GalleryImage[] {
  return [...images].sort((a, b) =>
    order === 'desc' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt,
  );
}
