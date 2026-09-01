/**
 * 把已落盘的生图结果另存到本地。
 *
 * 图片是**同源真实文件**(/user/files/bbi_*.png),故 `<a download>` 直接可用,
 * 不必先 fetch 成 blob——省一次全尺寸传输,也避开 blob URL 的生命周期管理。
 *
 * 两个容易踩的点:
 * - `<a>` 必须先挂进 document 再点:部分浏览器忽略未入文档节点上的合成点击;
 * - 移动端 Safari 不认 download 属性,会退化成「新标签打开」——此时用户仍可长按保存,
 *   属可接受降级(卡片与灯箱都另有长按保存路径,见 Lightbox.vue 顶部注释)。
 */
export function saveImageFile(src: string, filename?: string): void {
  if (!src) return;
  const link = document.createElement('a');
  link.href = src;
  link.download = filename || src.split('/').pop() || 'bbi-image.png';
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function imageDownloadFileName(
  src: string,
  characterName: string,
  generationId: string,
): string {
  const name = characterName.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'image';
  const extension = src.match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/)?.[1] || 'png';
  return `bbi_${name}_${generationId}.${extension}`;
}
