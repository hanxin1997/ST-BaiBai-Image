import { h, render } from 'vue';

import Lightbox from '@/floor/Lightbox.vue';

/**
 * 命令式打开图片灯箱(供楼层卡片调用)。
 *
 * 挂载位置与 components/confirm.ts 同款:插件 host 的 shadow root——那里有 dist/index.css
 * 与 --bbi-* 主题变量,挂 document.body 会裸奔无样式。
 *
 * 特意**不**挂进卡片自己的 shadow root:灯箱是 fixed 全屏层,而卡片活在 .mes_text 内部,
 * 那里的层叠上下文与 overflow 会把它裁掉。
 */

// 与 index.ts 的 HOST_ID 一致
const HOST_ID = 'bbi-app-host';

export interface LightboxOptions {
  src: string;
  prompt?: string;
  filename?: string;
  /** 提供了才显示删除按钮;点删除先关灯箱再回调。 */
  onDelete?: () => void;
}

/** 同一时刻只允许一个灯箱,重复调用先关旧的。 */
let closeCurrent: (() => void) | null = null;

export function openLightbox(options: LightboxOptions): void {
  const root = document.getElementById(HOST_ID)?.shadowRoot;
  if (!root) return;
  closeCurrent?.();

  const container = document.createElement('div');
  root.appendChild(container);

  const close = () => {
    if (closeCurrent !== close) return; // 已被后来者替换,不重复清理
    closeCurrent = null;
    render(null, container);
    container.remove();
  };
  closeCurrent = close;

  render(
    h(Lightbox, {
      src: options.src,
      prompt: options.prompt,
      filename: options.filename,
      deletable: !!options.onDelete,
      onClose: close,
      onDelete: () => {
        close();
        options.onDelete?.();
      },
    }),
    container,
  );
}
