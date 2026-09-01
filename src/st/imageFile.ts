/**
 * 图片文件的读取与缩放(DOM 侧小工具,与网络层 st/images.ts 分开)。
 *
 * NaiPanel 的 vibe 缩略图与画师串预览图共用:canvas 重绘成 jpeg,
 * 既压体积也把 png/webp/gif 统一成静态 jpeg(gif 动图会丢掉动效,预览图不在意)。
 */

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

/** 把 dataURL 图片缩到最长边 maxEdge 以内,重编码为 jpeg dataURL。 */
export async function makeJpegThumbnail(
  dataUrl: string,
  maxEdge: number,
  quality = 0.8,
): Promise<string> {
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}
