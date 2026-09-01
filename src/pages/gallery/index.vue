<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import Icon from '@/components/Icon.vue';
import BbiSelect from '@/components/BbiSelect.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import { openLightbox } from '@/floor/lightbox';
import { deleteImageFile } from '@/floor/upload';
import { getContext } from '@/st/context';
import { removeImageEntry } from '@/floor/storage';
import {
  collectAllImages,
  extractCharacters,
  filterByCharacter,
  filterBySearch,
  sortByTime,
  type GalleryImage,
} from './collect';

/**
 * 图库页。
 *
 * 遍历当前聊天的全部消息，提取 extra.bbiImage 中的图片元数据，展示为响应式网格。
 * 支持按角色筛选、提示词搜索、时间排序、多选批量删除。
 */

/** 全部图片（原始数据） */
const allImages = ref<GalleryImage[]>([]);

/** 筛选条件 */
const filterCharacterRaw = ref<string>('');
const searchQuery = ref('');
const sortOrder = ref<'desc' | 'asc'>('desc');

/** 筛选角色（空字符串 = 全部） */
const filterCharacter = computed(() => (filterCharacterRaw.value === '' ? null : filterCharacterRaw.value));

/** 多选状态 */
const selected = ref<Set<string>>(new Set());

/** 确认删除弹窗 */
const showDeleteConfirm = ref(false);

/** 刷新数据 */
function refresh(): void {
  allImages.value = collectAllImages();
  selected.value.clear();
}

/** 角色列表（用于筛选下拉） */
const characters = computed(() => extractCharacters(allImages.value));

/** 筛选后的图片 */
const filtered = computed(() => {
  let result = allImages.value;
  result = filterByCharacter(result, filterCharacter.value);
  result = filterBySearch(result, searchQuery.value);
  result = sortByTime(result, sortOrder.value);
  return result;
});

/** 全选 / 取消全选 */
const allSelected = computed({
  get: () => filtered.value.length > 0 && filtered.value.every(img => selected.value.has(img.generationId)),
  set: (val: boolean) => {
    if (val) {
      filtered.value.forEach(img => selected.value.add(img.generationId));
    } else {
      selected.value.clear();
    }
  },
});

/** 选中数量 */
const selectedCount = computed(() => selected.value.size);

/** 切换单张选择 */
function toggleSelect(img: GalleryImage): void {
  if (selected.value.has(img.generationId)) {
    selected.value.delete(img.generationId);
  } else {
    selected.value.add(img.generationId);
  }
}

/** 点击卡片（未选中时打开灯箱，已选中时取消选择） */
function onCardClick(img: GalleryImage, event: MouseEvent): void {
  // 点击 checkbox 或其 label 区域时不触发
  if ((event.target as HTMLElement).closest('.gal-card-checkbox-wrapper')) return;

  if (selected.value.size > 0) {
    toggleSelect(img);
  } else {
    openLightbox({
      src: img.path,
      prompt: img.prompt,
      filename: `bbi_${img.characterName}_${img.generationId}.png`,
      deletable: true,
      onDelete: async () => {
        await deleteSingle(img);
      },
    });
  }
}

/** 删除单张（从 Lightbox 内触发） */
async function deleteSingle(img: GalleryImage): Promise<void> {
  try {
    await deleteImageFile(img.path);
    const ctx = getContext();
    if (ctx) {
      await removeImageEntry(ctx, img.mesid, img.swipeId, img.generationId);
    }
    refresh();
  } catch (error) {
    console.error('[图库] 删除图片失败', error);
    alert(`删除失败：${error instanceof Error ? error.message : '未知错误'}`);
  }
}

/** 批量删除确认 */
function confirmBatchDelete(): void {
  if (selectedCount.value === 0) return;
  showDeleteConfirm.value = true;
}

/** 执行批量删除 */
async function executeBatchDelete(): Promise<void> {
  showDeleteConfirm.value = false;
  const toDelete = allImages.value.filter(img => selected.value.has(img.generationId));
  if (toDelete.length === 0) return;

  let success = 0;
  let failed = 0;

  for (const img of toDelete) {
    try {
      await deleteImageFile(img.path);
      const ctx = getContext();
      if (ctx) {
        await removeImageEntry(ctx, img.mesid, img.swipeId, img.generationId);
      }
      success++;
    } catch (error) {
      console.error('[图库] 删除图片失败', img.path, error);
      failed++;
    }
  }

  refresh();

  if (failed > 0) {
    alert(`删除完成：成功 ${success} 张，失败 ${failed} 张`);
  }
}

/** 格式化时间 */
function formatTime(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const isToday =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();

  if (isToday) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

/** 搜索防抖 */
let searchTimer: ReturnType<typeof setTimeout> | null = null;
const searchInput = ref('');
watch(searchInput, val => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchQuery.value = val;
  }, 300);
});

/** 初始加载 */
refresh();

/** 监听聊天切换，自动刷新 */
const ctx = getContext();
if (ctx?.eventSource && ctx.eventTypes) {
  ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, refresh);
  ctx.eventSource.on(ctx.eventTypes.MESSAGE_UPDATED, refresh);
}
</script>

<template>
  <section class="bbi-page">
    <div class="bbi-page-head">
      <h2 class="bbi-title bbi-title-sub">图库</h2>
    </div>
    <hr class="bbi-rule" />

    <!-- 工具栏 -->
    <div class="gal-toolbar">
      <!-- 角色筛选 -->
      <BbiSelect
        v-model="filterCharacterRaw"
        :options="[{ value: '', label: '全部角色' }, ...characters.map(c => ({ value: c, label: c }))]"
        style="width: 160px"
      />

      <!-- 排序 -->
      <BbiSelect
        v-model="sortOrder"
        :options="[
          { value: 'desc', label: '时间：新→旧' },
          { value: 'asc', label: '时间：旧→新' },
        ]"
        style="width: 140px"
      />

      <!-- 搜索 -->
      <input
        v-model="searchInput"
        type="text"
        class="gal-search"
        placeholder="搜索提示词..."
      />

      <div style="flex: 1"></div>

      <!-- 全选 -->
      <label class="gal-checkbox-label">
        <input v-model="allSelected" type="checkbox" />
        全选
      </label>

      <!-- 批量删除 -->
      <button
        class="bbi-btn bbi-btn-danger"
        :disabled="selectedCount === 0"
        @click="confirmBatchDelete"
      >
        <Icon name="delete" :size="14" />
        删除{{ selectedCount > 0 ? `(${selectedCount})` : '' }}
      </button>
    </div>

    <!-- 空状态 -->
    <div v-if="filtered.length === 0" class="gal-empty">
      <Icon name="gallery" :size="40" />
      <p class="gal-empty-title">
        {{ allImages.length === 0 ? '还没有生成过图片' : '没有符合条件的图片' }}
      </p>
      <p v-if="allImages.length > 0" class="gal-empty-hint">
        试试调整筛选条件
      </p>
    </div>

    <!-- 图片网格 -->
    <div v-else class="gal-grid">
      <div
        v-for="img in filtered"
        :key="img.generationId"
        class="gal-card"
        :class="{ 'gal-card-selected': selected.has(img.generationId) }"
        @click="onCardClick(img, $event)"
      >
        <img :src="img.path" :alt="img.characterName" loading="lazy" />

        <!-- 选择框 -->
        <div class="gal-card-checkbox-wrapper">
          <input
            :checked="selected.has(img.generationId)"
            type="checkbox"
            class="gal-card-checkbox"
            @click.stop
            @change="toggleSelect(img)"
          />
        </div>

        <!-- 悬浮信息 -->
        <div class="gal-card-info">
          <div class="gal-card-info-char">{{ img.characterName }}</div>
          <div class="gal-card-info-meta">
            第 {{ img.mesid + 1 }} 楼 · {{ formatTime(img.createdAt) }}
          </div>
        </div>
      </div>
    </div>

    <!-- 底部统计 -->
    <div v-if="filtered.length > 0" class="gal-footer">
      共 {{ filtered.length }} 张图片
      <span v-if="filtered.length < allImages.length" class="gal-footer-hint">
        （已筛选，全部 {{ allImages.length }} 张）
      </span>
    </div>

    <!-- 删除确认弹窗 -->
    <ConfirmDialog
      v-if="showDeleteConfirm"
      :open="true"
      title="确认删除"
      confirm-text="删除"
      cancel-text="取消"
      tone="danger"
      @confirm="executeBatchDelete"
      @cancel="showDeleteConfirm = false"
    >
      确定要删除选中的 {{ selectedCount }} 张图片吗？此操作不可撤销。
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.gal-toolbar {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 16px;
}

.gal-search {
  width: 200px;
  padding: 6px 10px;
  background: var(--bbi-surface-1);
  border: 1px solid var(--bbi-border);
  border-radius: var(--bbi-radius);
  color: var(--bbi-ink);
  font-size: 13px;
}

.gal-search::placeholder {
  color: var(--bbi-ink-soft);
}

.gal-checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--bbi-ink);
  cursor: pointer;
  user-select: none;
}

.gal-checkbox-label input {
  cursor: pointer;
}

.gal-empty {
  display: grid;
  place-items: center;
  gap: 10px;
  padding: 90px 20px;
  color: var(--bbi-ink-soft);
  text-align: center;
}

.gal-empty-title {
  margin: 0;
  font-size: 15px;
  color: var(--bbi-ink);
}

.gal-empty-hint {
  margin: 0;
  font-size: 12.5px;
}

.gal-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
  margin-top: 16px;
  content-visibility: auto;
}

.gal-card {
  position: relative;
  aspect-ratio: 1;
  background: var(--bbi-surface-2);
  border-radius: var(--bbi-radius);
  overflow: hidden;
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s;
}

.gal-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.gal-card-selected {
  outline: 3px solid var(--bbi-accent);
  outline-offset: -3px;
}

.gal-card img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.gal-card-checkbox-wrapper {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 2;
}

.gal-card-checkbox {
  width: 20px;
  height: 20px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
  accent-color: var(--bbi-accent);
}

.gal-card:hover .gal-card-checkbox,
.gal-card-checkbox:checked,
.gal-card-selected .gal-card-checkbox {
  opacity: 1;
}

.gal-card-info {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 8px 10px;
  background: linear-gradient(transparent, rgba(5, 7, 12, 0.85));
  color: rgba(255, 255, 255, 0.95);
  font-size: 12px;
  opacity: 0;
  transition: opacity 0.15s;
  pointer-events: none;
}

.gal-card:hover .gal-card-info {
  opacity: 1;
}

.gal-card-info-char {
  font-weight: 500;
  margin-bottom: 2px;
}

.gal-card-info-meta {
  font-size: 11px;
  opacity: 0.8;
}

.gal-footer {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--bbi-border);
  font-size: 13px;
  color: var(--bbi-ink-soft);
  text-align: center;
}

.gal-footer-hint {
  opacity: 0.7;
}

@media (max-width: 768px) {
  .gal-grid {
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 10px;
  }

  .gal-toolbar {
    flex-wrap: wrap;
  }

  .gal-search {
    width: 100%;
    order: 10;
  }
}
</style>
