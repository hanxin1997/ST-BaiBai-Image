<script setup lang="ts">
import { SELECTABLE_BACKENDS, settings, type BackendId } from '@/state/settings';
import { computed, ref, watch, type Component } from 'vue';
import ComfyUIPanel from './panels/ComfyUIPanel.vue';
import ImgRouterPanel from './panels/ImgRouterPanel.vue';
import NaiPanel from './panels/NaiPanel.vue';
import WebUIPanel from './panels/WebUIPanel.vue';

// 渠道页:页签只负责「看哪个面板」(纯浏览,本地状态,初始跟随当前出图渠道)。
// 真正的选择在各面板的「使用此渠道出图」按钮(选中后显示「当前出图渠道」)
// 与设置页「出图后端」下拉,两处都读写 settings.defaultBackend,任一处改动自动跟随。
// webui 暂不开放:入口藏掉(代码保留,便于后续恢复);merge 已把存量 webui 值迁移走,这里恒有匹配页签。
// 名单的真源在 settings.ts 的 SELECTABLE_BACKENDS,与设置页下拉、迁移守卫共用一份。
const VISIBLE_BACKENDS = SELECTABLE_BACKENDS;

// 上次停在哪个渠道页签:与 activePage 同理——纯本机浏览态,存 localStorage,
// 不进 settings.json(翻页签即回写服务器太频繁,且跨设备同步无意义)。
const TAB_STORAGE_KEY = 'bbi.backend.tab.v1';

function loadViewing(): BackendId | null {
  try {
    const v = localStorage.getItem(TAB_STORAGE_KEY);
    return VISIBLE_BACKENDS.some(b => b.value === v) ? (v as BackendId) : null;
  } catch {
    return null;
  }
}

// 优先级:上次看的页签 > 当前出图渠道 > 第一个可见页签。
const viewing = ref<BackendId>(
  loadViewing() ??
    (VISIBLE_BACKENDS.some(b => b.value === settings.defaultBackend)
      ? settings.defaultBackend
      : VISIBLE_BACKENDS[0].value),
);

watch(viewing, v => {
  try {
    localStorage.setItem(TAB_STORAGE_KEY, v);
  } catch {
    /* localStorage 不可用时静默 */
  }
});

// latent 与 nai 共用 NaiPanel:协议相同,靠 :target 区分读写哪条渠道的配置
// (见 NaiPanel 文件头)。照抄一份 2000 行面板才是真的维护不起。
const PANELS: Record<BackendId, Component> = {
  webui: WebUIPanel,
  comfyui: ComfyUIPanel,
  nai: NaiPanel,
  latent: NaiPanel,
  imgrouter: ImgRouterPanel,
};
const activePanel = computed(() => PANELS[viewing.value]);

/**
 * 只有 NaiPanel 读这个 prop;其余面板收到多余 attr 无副作用(Vue 会当 fallthrough)。
 * 收窄成 'nai' | 'latent' 是因为 NaiPanel 的 target 只认这两个值,直接透传 BackendId 过不了类型。
 */
const panelTarget = computed<'nai' | 'latent'>(() => (viewing.value === 'latent' ? 'latent' : 'nai'));
</script>

<template>
  <section class="bbi-page">
    <div class="bbi-page-head">
      <h2 class="bbi-title bbi-title-sub">渠道</h2>
      <div class="bbi-segmented" role="tablist" aria-label="生图渠道">
        <button
          v-for="b in VISIBLE_BACKENDS"
          :key="b.value"
          class="bbi-seg"
          :class="{ 'is-on': viewing === b.value }"
          type="button"
          role="tab"
          :aria-selected="viewing === b.value"
          @click="viewing = b.value"
        >
          {{ b.label }}
        </button>
      </div>
    </div>
    <hr class="bbi-rule" />

    <!-- KeepAlive:切换渠道时保留各面板的折叠/输入状态 -->
    <KeepAlive>
      <component :is="activePanel" :key="viewing" :target="panelTarget" />
    </KeepAlive>
  </section>
</template>

<style scoped>
/* 窄屏下标题与渠道分段控件分两行,不挤压 */
.bbi-page-head {
  flex-wrap: wrap;
}
</style>
