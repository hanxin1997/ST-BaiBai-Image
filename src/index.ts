import App from '@/App.vue';
import { bindAutoTagging } from '@/autoTag/runner';
import { bindTagActionButtons } from '@/floor/actionButton';
import { bindFloorHydration } from '@/floor/hydrate';
import { injectMenuButton } from '@/menu';
import { registerPublicInterface } from '@/public/register';
import { bindCharTagSync } from '@/state/charTags';
import { initGlobalCharTags } from '@/state/globalCharTags';
import { hydrateSettings } from '@/state/settings';
import { ui } from '@/state/ui';
import { guardEditableArrowKeys } from '@/st/keyboard';
import { ensureImageTagRegexRegistered } from '@/st/imageTagRegex';
import { syncTopBarButton } from '@/topbar';
import { checkForUpdate } from '@/update';
import { versionedAssetUrl } from '@/version';
// 这两行让 Vite 把全局样式打进 dist/index.css(随后注入 shadow root)
import '@/styles/base.css';
import '@/styles/theme.css';
import { createApp, watch } from 'vue';

const HOST_ID = 'bbi-app-host';

/**
 * 可继承的排版属性——shadow DOM 不隔离继承,这些会透过 host 从 ST 漏进来。
 * 在 host 上用内联 !important 钉死,从根上切断继承链。
 */
const INHERITED_RESET: Record<string, string> = {
  'font-family':
    "'MiSans','HarmonyOS Sans SC','PingFang SC','Microsoft YaHei',-apple-system,BlinkMacSystemFont,'Segoe UI','Inter',system-ui,sans-serif",
  'font-size': '14px',
  'font-weight': '400',
  'font-style': 'normal',
  'font-variant': 'normal',
  'line-height': '1.6',
  'letter-spacing': 'normal',
  'word-spacing': 'normal',
  'text-align': 'left',
  'text-transform': 'none',
  'text-indent': '0',
  'text-shadow': 'none',
  'white-space': 'normal',
  color: '#1c242c',
  direction: 'ltr',
};

function mount() {
  // host 元素留在 ST 的 light DOM,Vue 应用整体活在它的 shadow root 里。
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    document.body.appendChild(host);
  }

  // host 不参与布局(窗口内部用 fixed 定位),并切断继承
  host.style.setProperty('display', 'contents', 'important');
  for (const [prop, value] of Object.entries(INHERITED_RESET)) {
    host.style.setProperty(prop, value, 'important');
  }

  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  shadow.textContent = '';
  guardEditableArrowKeys(shadow);

  // 把我们构建出的 dist/index.css 以 <link> 注入 shadow root——
  // 这样样式只在这棵 shadow 树内生效,ST 全局样式进不来,我们的也出不去。
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  // index.js 与 index.css 在 dist 同级,据当前模块 URL 推导,部署路径无关。
  link.href = versionedAssetUrl('./index.css', import.meta.url);
  shadow.appendChild(link);

  const container = document.createElement('div');
  shadow.appendChild(container);

  const app = createApp(App);
  app.mount(container);

  $(window).on('pagehide', () => app.unmount());
}

$(() => {
  mount();
  injectMenuButton();
  // 顶栏快速打开按钮:按开关注入/移除。watch 在开关变化(含 hydrate 回灌真值)时同步。
  syncTopBarButton(ui.showTopBar);
  watch(
    () => ui.showTopBar,
    on => syncTopBarButton(on),
  );
  // 等 ST 的 getContext 就绪后再 hydrate 设置(加载顺序不确定时轮询)
  hydrateWhenReady();
});

async function hydrateWhenReady(attempt = 0) {
  if (!(window as unknown as { SillyTavern?: { getContext?: unknown } }).SillyTavern?.getContext) {
    if (attempt > 40) {
      console.error('[柏宝绘] 等待 SillyTavern 就绪超时,初始化未执行');
      return;
    }
    setTimeout(() => hydrateWhenReady(attempt + 1), 500);
    return;
  }
  // 顺序即依赖:全局库先于角色库同步;公开接口排在设置回灌与角色库同步之后,
  // 否则 getBackendStatus()/revision 读的是默认值。单步失败不断链——
  // 历史教训:hydrate 抛错曾把自动 tag、楼层按钮、卡片水合一并带走,
  // 用户只看到「插件整个没反应」,却不知道是哪一步坏了。
  const steps: InitStep[] = [
    ['设置载入', hydrateSettings],
    ['全局角色库初始化', initGlobalCharTags],
    ['角色库同步', bindCharTagSync],
    ['图片标签正则', ensureImageTagRegexRegistered],
    ['自动 tag 事件', bindAutoTagging],
    ['楼层水合', bindFloorHydration],
    ['楼层按钮', bindTagActionButtons],
    ['公开接口', registerPublicInterface],
  ];
  let failed = 0;
  for (const step of steps) {
    if (!(await runStep(step))) failed += 1;
  }
  void checkForUpdate();
  if (failed) {
    toastr.error(`柏宝绘初始化有 ${failed} 项失败,详见控制台`, '柏宝绘');
    return;
  }
  console.log(`[柏宝绘] 已加载 v${__BBI_VERSION__},设置已同步`);
}

type InitStep = readonly [name: string, run: () => void | Promise<void>];

/** 单步初始化隔离:失败只记录自己,不阻断后续绑定。 */
async function runStep([name, run]: InitStep): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (e) {
    console.error(`[柏宝绘] 初始化步骤「${name}」失败`, e);
    return false;
  }
}
