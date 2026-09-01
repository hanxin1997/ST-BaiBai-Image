<script setup lang="ts">
import Icon from '@/components/Icon.vue';

/**
 * 图库页(占位)。
 *
 * 定位已定为「依赖柏宝库服务端插件的可选增强页」:ST 自带的 user/files
 * 不能建子目录、没有列举能力,撑不起图库;等柏宝库的接口(探测 + JSON 读写
 * + 列举 + 删除)成型后这里才落地真功能。先放占位,回应「能不能做图库」的问题。
 */
</script>

<template>
  <section class="bbi-page">
    <div class="bbi-page-head">
      <h2 class="bbi-title bbi-title-sub">图库</h2>
    </div>
    <hr class="bbi-rule" />

    <div class="gal-pending">
      <Icon name="gallery" :size="40" />
      <p class="gal-pending-title">制作中，后续更新</p>
      <p class="gal-pending-hint">生成过的图片会集中展示在这里浏览、查找与复用。</p>
    </div>
  </section>
</template>

<style scoped>
.gal-pending {
  display: grid;
  place-items: center;
  gap: 10px;
  padding: 90px 20px;
  color: var(--bbi-ink-soft);
  text-align: center;
}
.gal-pending-title {
  margin: 0;
  font-size: 15px;
  color: var(--bbi-ink);
}
.gal-pending-hint {
  margin: 0;
  font-size: 12.5px;
}
</style>
