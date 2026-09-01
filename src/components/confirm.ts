import { h, render } from 'vue';

import ConfirmDialog from '@/components/ConfirmDialog.vue';

export interface ConfirmOptions {
  title: string;
  /** 正文(纯文本) */
  text: string;
  confirmText?: string;
  cancelText?: string;
  tone?: 'primary' | 'danger';
}

// 与 index.ts 的 HOST_ID 保持一致:插件宿主元素,其 shadow root 里有 dist/index.css
// 与 --bbi-* 主题变量;弹窗必须挂进去才有样式(挂 document.body 会裸奔)。
const HOST_ID = 'bbi-app-host';

/**
 * 命令式确认弹窗:供聊天侧(楼层按钮等模板外环境)使用,替代浏览器原生 confirm。
 * 挂载进插件 host 的 shadow root;插件窗口开着时 ConfirmDialog 内部 Teleport 到
 * modalHost(浮于窗口之上),关着时 Teleport 禁用、原地渲染,两种状态都可用。
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  const root = document.getElementById(HOST_ID)?.shadowRoot;
  if (!root) {
    // 取不到 host 等于弹不出窗,返回 false 会被调用方当成「用户取消了」而静默放弃 ——
    // 至少留一行日志,否则表现是「点了没反应」且无从排查。
    console.warn('[柏宝绘] 插件 host 不在,确认弹窗无法呼出', { hostId: HOST_ID, title: options.title });
    return Promise.resolve(false);
  }

  const container = document.createElement('div');
  root.appendChild(container);
  return new Promise(resolve => {
    const settle = (result: boolean) => {
      render(null, container);
      container.remove();
      resolve(result);
    };
    render(
      h(
        ConfirmDialog,
        {
          open: true,
          title: options.title,
          confirmText: options.confirmText,
          cancelText: options.cancelText,
          tone: options.tone,
          // 聊天侧呼出时可能压在插件窗口/其它弹窗之上
          topLayer: true,
          onConfirm: () => settle(true),
          onCancel: () => settle(false),
        },
        { default: () => options.text },
      ),
      container,
    );
  });
}
