<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { artistPreviewSrc } from '@/pages/backend/panels/artistPreview';
import type { NaiArtistPreset } from '@/state/settings';

/**
 * 画师串卡片(库网格与方案挑选弹窗共用)。
 *
 * 只管呈现与事件:点主体、勾选、编辑、复制、删除、启用都由调用方决定语义——
 * 库里的「点主体」是打开编辑,挑选弹窗里是选中,两者对卡片的期望不同。
 */
const props = defineProps<{
  preset: NaiArtistPreset;
  builtin?: boolean;
  /** 当前使用中(描边 + 徽标)。 */
  active?: boolean;
  /** 多选态勾选;undefined = 不显示勾选框(非多选态)。 */
  checked?: boolean;
  /** 多选态下不可勾选(内置条)。 */
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: 'click'): void;
  (e: 'toggle-select'): void;
  (e: 'edit'): void;
  (e: 'duplicate'): void;
  (e: 'delete'): void;
  (e: 'use'): void;
}>();

function onToggleSelect(event: Event): void {
  event.stopPropagation();
  emit('toggle-select');
}
</script>

<template>
  <div
    class="at"
    :class="{ 'is-active': active, 'is-checked': checked, 'is-disabled': disabled }"
    role="button"
    tabindex="0"
    @click="emit('click')"
    @keydown.enter="emit('click')"
  >
    <div class="at-art">
      <img
        v-if="preset.previewPath"
        class="at-art-img"
        :src="artistPreviewSrc(preset)"
        :alt="preset.name"
        loading="lazy"
        decoding="async"
      />
      <div v-else class="at-art-empty">
        <Icon :name="builtin ? 'nai' : 'generate'" :size="20" />
        <span v-if="!builtin">无预览图</span>
      </div>

      <label v-if="checked !== undefined" class="at-check" title="勾选后可批量删除" @click.stop>
        <input
          type="checkbox"
          class="bbi-checkbox"
          :checked="checked"
          :disabled="disabled"
          aria-label="选择此画师串"
          @change="onToggleSelect"
        />
      </label>

      <span v-if="active" class="at-badge is-on">使用中</span>
      <span v-else-if="builtin" class="at-badge">内置</span>
    </div>

    <div class="at-body">
      <div class="at-name" :title="preset.name">{{ preset.name || '未命名画师串' }}</div>
      <div class="at-prompt" :title="preset.prompt">{{ preset.prompt || '(空)' }}</div>
      <div class="at-ops" @click.stop>
        <button
          class="at-op at-op-use"
          type="button"
          :class="{ 'is-on': active }"
          :title="active ? '停用这条画师串' : '使用这条画师串'"
          @click="emit('use')"
        >
          <Icon :name="active ? 'check' : 'palette'" :size="12" />
          {{ active ? '使用中' : '使用' }}
        </button>
        <span class="at-op-spacer" />
        <button
          class="at-op"
          type="button"
          :title="builtin ? '查看内容(内置只读)' : '编辑名称与内容'"
          :aria-label="builtin ? '查看内容' : '编辑'"
          @click="emit('edit')"
        >
          <Icon name="edit" :size="13" />
        </button>
        <button class="at-op" type="button" title="复制为我的画师串" aria-label="复制" @click="emit('duplicate')">
          <Icon name="copy" :size="13" />
        </button>
        <button
          v-if="!builtin"
          class="at-op at-op-danger"
          type="button"
          title="删除"
          aria-label="删除"
          @click="emit('delete')"
        >
          <Icon name="trash" :size="13" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.at {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface);
  overflow: hidden;
  cursor: pointer;
  transition:
    border-color var(--bbi-dur) var(--bbi-ease),
    box-shadow var(--bbi-dur) var(--bbi-ease),
    background var(--bbi-dur) var(--bbi-ease);
}

.at:hover {
  border-color: var(--bbi-accent);
}

.at.is-active {
  border-color: var(--bbi-accent);
  box-shadow: 0 0 0 1px var(--bbi-accent);
}

.at.is-checked {
  background: var(--bbi-accent-soft);
}

.at.is-disabled {
  opacity: 0.7;
}

.at-art {
  position: relative;
  aspect-ratio: 4 / 3;
  background: var(--bbi-surface-2);
}

.at-art-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.at-art-empty {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  font-size: 11px;
  color: var(--bbi-ink-soft);
}

.at-check {
  position: absolute;
  top: 6px;
  left: 6px;
  z-index: 1;
  padding: 2px;
  border-radius: var(--bbi-radius-sm);
  background: oklch(1 0 0 / 0.75);
}

.at-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  padding: 1px 6px;
  border-radius: var(--bbi-radius-pill);
  font-size: 10px;
  background: oklch(0 0 0 / 0.55);
  color: oklch(1 0 0 / 0.92);
}

.at-badge.is-on {
  background: var(--bbi-accent);
  color: var(--bbi-on-accent, #fff);
}

.at-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px 10px;
}

.at-name {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.at-prompt {
  font-size: 11px;
  line-height: 1.35;
  color: var(--bbi-ink-soft);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 2.7em;
}

.at-ops {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
}

.at-op-spacer {
  flex: 1 1 auto;
}

.at-op {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 5px;
  border: 0;
  border-radius: var(--bbi-radius-sm);
  background: transparent;
  color: var(--bbi-ink-muted);
  font-size: 11px;
  cursor: pointer;
}

.at-op:hover {
  background: var(--bbi-surface-2);
  color: var(--bbi-ink);
}

.at-op-use.is-on {
  color: var(--bbi-accent);
}

.at-op-danger:hover {
  color: var(--bbi-danger, #c0392b);
}
</style>
