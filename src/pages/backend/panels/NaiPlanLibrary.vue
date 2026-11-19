<script setup lang="ts">
import { computed, ref } from 'vue';
import BbiSelect from '@/components/BbiSelect.vue';
import BbiTextarea from '@/components/BbiTextarea.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import {
  BUILTIN_NAI_ARTISTS,
  generateNaiImage,
  naiRandomSeed,
  naiSamplers,
  NAI_NOISE_SCHEDULES,
  NAI_SAMPLERS,
} from '@/backends/nai';
import { acquireNaiSlot } from '@/floor/genQueue';
import { makeJpegThumbnail, readFileAsDataUrl } from '@/st/imageFile';
import { deleteUserImage, NAI_PLAN_PREVIEW_FOLDER, uploadUserImage } from '@/st/images';
import { artistPreviewSrc, bumpArtistPreview } from '@/pages/backend/panels/artistPreview';
import {
  activeNaiPlan,
  effectiveNai,
  newNaiPlan,
  NAI_MODELS,
  ORIENTATION_LOCKS,
  setActiveNaiPlan,
  settings,
  syncNaiMirror,
  type NaiPlan,
} from '@/state/settings';

/**
 * NAI 出图方案库(卡片网格 + 编辑弹窗),体验对齐 Latent 原生 API 的配置库。
 *
 * 一套方案 = 提示词(画师串/质量词/负面词/Vibe)+ 参数(模型/采样/尺寸)+ 预览图。
 * 画师串库、Vibe 库、接入点仍是独立库,方案里只存引用;切方案整套生效。
 */
const conn = computed(() => settings.nai);
const plans = computed(() => conn.value.plans);
const plan = computed(() => activeNaiPlan(conn.value));
const activeId = computed(() => plan.value.id);

const SAMPLER_OPTIONS = computed(() => naiSamplers(plan.value.model));
const NOISE_OPTIONS = NAI_NOISE_SCHEDULES;
const ARTIST_NONE = '';

const artistOptions = computed(() => [
  { value: ARTIST_NONE, label: '不使用' },
  { value: CUSTOM_ARTIST, label: '自定义…' },
  ...BUILTIN_NAI_ARTISTS.map(a => ({ value: a.id, label: `${a.name}(内置)` })),
  ...conn.value.artistPresets.map(a => ({ value: a.id, label: a.name || '未命名画师串' })),
]);

const CUSTOM_ARTIST = '__custom__';

/** 下拉的「自定义」是方案级 artistPrompt,不是库条目;用独立 ref 记住这个选择。 */
const customArtist = ref(false);
const draftArtist = computed<string>({
  get: () => (customArtist.value ? CUSTOM_ARTIST : draft.value?.artistId ?? ARTIST_NONE),
  set: value => {
    if (!draft.value) return;
    if (value === CUSTOM_ARTIST) {
      customArtist.value = true;
      draft.value.artistId = '';
      return;
    }
    customArtist.value = false;
    draft.value.artistId = value;
    draft.value.artistPrompt = '';
  },
});

function artistName(id: string): string {
  if (!id) return '不使用画师串';
  return (
    conn.value.artistPresets.find(a => a.id === id)?.name ??
    BUILTIN_NAI_ARTISTS.find(a => a.id === id)?.name ??
    '画师串已删除'
  );
}

function switchPlan(id: string): void {
  setActiveNaiPlan(id, conn.value);
  applyPlanVibes(activeNaiPlan(conn.value));
}

/** 方案切换 = 把该方案勾选的 vibe 套回库(库内 enabled 是唯一开关)。 */
function applyPlanVibes(target: NaiPlan): void {
  const ids = new Set(target.vibeIds);
  for (const vibe of conn.value.vibes) vibe.enabled = ids.has(vibe.id);
}

function addPlan(): void {
  const created = newNaiPlan(`方案 ${conn.value.plans.length + 1}`);
  created.endpointId = plan.value.endpointId;
  created.artistId = plan.value.artistId;
  conn.value.plans.push(created);
  setActiveNaiPlan(created.id, conn.value);
  applyPlanVibes(created);
  toastr.success(`已新建「${created.name}」`, '出图方案');
}

function duplicatePlan(source: NaiPlan): void {
  const copy: NaiPlan = {
    ...source,
    id: newNaiPlan().id,
    name: `${source.name} 副本`,
    vibeIds: [...source.vibeIds],
  };
  delete copy.previewPath;
  const index = conn.value.plans.findIndex(p => p.id === source.id);
  conn.value.plans.splice(index + 1, 0, copy);
  setActiveNaiPlan(copy.id, conn.value);
  applyPlanVibes(copy);
  toastr.success(`已复制为「${copy.name}」`, '出图方案');
}

async function deletePlan(target: NaiPlan): Promise<void> {
  if (conn.value.plans.length <= 1) return;
  const index = conn.value.plans.findIndex(p => p.id === target.id);
  conn.value.plans.splice(index, 1);
  const next = conn.value.plans[Math.min(index, conn.value.plans.length - 1)];
  setActiveNaiPlan(next.id, conn.value);
  applyPlanVibes(next);
  if (target.previewPath) {
    try {
      await deleteUserImage(target.previewPath);
    } catch (error) {
      toastr.warning(`方案已删除,但预览图文件清理失败：${errorMessage(error)}`, '出图方案');
    }
  }
  toastr.success(`已删除「${target.name}」`, '出图方案');
}

/* ============ 编辑弹窗(草稿态,保存才写回) ============ */

const editing = ref<NaiPlan | null>(null);
const draft = ref<NaiPlan | null>(null);

function openEdit(target: NaiPlan): void {
  editing.value = target;
  draft.value = { ...target, vibeIds: [...target.vibeIds] };
  customArtist.value = !!target.artistPrompt.trim();
}

function cancelEdit(): void {
  editing.value = null;
  draft.value = null;
  customArtist.value = false;
}

function saveEdit(): void {
  const target = editing.value;
  const value = draft.value;
  if (!target || !value) return;
  Object.assign(target, value);
  if (target.id === activeId.value) syncNaiMirror(conn.value);
  editing.value = null;
  draft.value = null;
  customArtist.value = false;
  toastr.success(`已保存「${target.name}」`, '出图方案');
}

function toggleDraftVibe(id: string): void {
  if (!draft.value) return;
  const ids = new Set(draft.value.vibeIds);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  draft.value.vibeIds = [...ids];
}

const draftSamplerOptions = computed(() =>
  draft.value ? naiSamplers(draft.value.model) : NAI_SAMPLERS.map(s => ({ value: s.value, label: s.label })),
);

/* ============ 预览图 ============ */

const previewBusy = ref<string | null>(null);
const previewAbort = ref<AbortController | null>(null);
const previewFileInput = ref<HTMLInputElement | null>(null);
let previewTarget: NaiPlan | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function previewBase64(url: string): Promise<string> {
  return (url.startsWith('data:')
    ? Promise.resolve(url)
    : fetch(url)
        .then(response => response.blob())
        .then(
          blob =>
            new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result ?? ''));
              reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'));
              reader.readAsDataURL(blob);
            }),
        )
  ).then(dataUrl => makeJpegThumbnail(dataUrl, 512, 0.85));
}

async function generatePreview(target: NaiPlan): Promise<void> {
  if (previewBusy.value) return;
  if (!conn.value.key.trim()) {
    toastr.error('请先填写 NAI API Key', '出图方案');
    return;
  }
  if (!target.previewPrompt.trim()) {
    toastr.error('请先填写示例提示词', '出图方案');
    return;
  }
  previewBusy.value = target.id;
  const controller = new AbortController();
  previewAbort.value = controller;
  let release: (() => void) | null = null;
  let resultUrl = '';
  try {
    const run = effectiveNai(conn.value, target);
    release = await acquireNaiSlot(controller.signal, run.endpointId);
    const output = await generateNaiImage(
      run,
      {
        prompt: target.previewPrompt,
        nl: '',
        characters: [],
        seed: target.seed > 0 ? target.seed : naiRandomSeed(),
        size: target.orientationLock === 'auto' ? 'portrait' : target.orientationLock,
      },
      controller.signal,
    );
    resultUrl = output.result.url;
    const jpeg = await previewBase64(resultUrl);
    target.previewPath = await uploadUserImage(
      NAI_PLAN_PREVIEW_FOLDER,
      target.id,
      jpeg.split(',')[1] ?? '',
      'jpg',
    );
    bumpArtistPreview(target.id);
    toastr.success(`「${target.name}」预览图已更新`, '出图方案');
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      toastr.info('已取消生成预览图', '出图方案');
    } else {
      toastr.error(errorMessage(error), '生成预览图失败');
    }
  } finally {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    previewBusy.value = null;
    previewAbort.value = null;
    release?.();
  }
}

function pickPreview(target: NaiPlan): void {
  if (previewBusy.value) return;
  previewTarget = target;
  previewFileInput.value?.click();
}

async function onPreviewFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  const target = previewTarget;
  previewTarget = null;
  if (!file || !target) return;
  try {
    const dataUrl = await readFileAsDataUrl(file);
    const jpeg = await makeJpegThumbnail(dataUrl, 512, 0.85);
    target.previewPath = await uploadUserImage(
      NAI_PLAN_PREVIEW_FOLDER,
      target.id,
      jpeg.split(',')[1] ?? '',
      'jpg',
    );
    bumpArtistPreview(target.id);
  } catch (error) {
    toastr.error(errorMessage(error), '预览图上传失败');
  }
}

async function removePreview(target: NaiPlan): Promise<void> {
  const path = target.previewPath;
  if (!path) return;
  target.previewPath = undefined;
  try {
    await deleteUserImage(path);
  } catch (error) {
    toastr.warning(`预览图引用已移除,但文件清理失败：${errorMessage(error)}`, '出图方案');
  }
}
</script>

<template>
  <div class="npl">
    <div class="npl-grid">
      <div
        v-for="p in plans"
        :key="p.id"
        class="npl-card"
        :class="{ 'is-on': p.id === activeId }"
        role="button"
        tabindex="0"
        @click="switchPlan(p.id)"
        @keydown.enter="switchPlan(p.id)"
      >
        <div class="npl-art">
          <img
            v-if="p.previewPath"
            class="npl-art-img"
            :src="artistPreviewSrc(p)"
            :alt="p.name"
            loading="lazy"
            decoding="async"
          />
          <div v-else class="npl-art-empty">
            <Icon name="palette" :size="20" />
            <span>出图后自动出现</span>
          </div>
          <span v-if="p.id === activeId" class="npl-badge is-on">使用中</span>
        </div>
        <div class="npl-body">
          <div class="npl-name">{{ p.name || '未命名方案' }}</div>
          <div class="npl-meta">{{ p.model }} · {{ p.portraitSize }}</div>
          <div class="npl-meta">{{ p.artistPrompt.trim() ? '自定义画师串' : artistName(p.artistId) }}</div>
          <div class="npl-ops" @click.stop>
            <button class="bbi-btn bbi-btn-sm" type="button" @click="openEdit(p)">
              <Icon name="edit" :size="12" /> 编辑
            </button>
            <button class="bbi-btn bbi-btn-sm" type="button" @click="duplicatePlan(p)">
              <Icon name="copy" :size="12" /> 复制
            </button>
            <button
              class="bbi-btn bbi-btn-sm bbi-btn-danger"
              type="button"
              :disabled="plans.length <= 1"
              @click="deletePlan(p)"
            >
              <Icon name="trash" :size="12" /> 删除
            </button>
          </div>
        </div>
      </div>
    </div>
    <button class="bbi-btn bbi-btn-sm npl-add" type="button" @click="addPlan">
      <Icon name="plus" :size="12" /> 新建方案
    </button>

    <!-- ===== 编辑弹窗:提示词 / 参数 / 预览图 ===== -->
    <ModalMask :open="!!draft" @close="cancelEdit">
      <div v-if="draft" class="bbi-modal npl-edit" role="dialog" aria-modal="true" aria-label="编辑出图方案">
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">编辑出图方案</span>
          <button class="bbi-icon-mini" type="button" title="关闭" aria-label="关闭" @click="cancelEdit">
            <Icon name="close" />
          </button>
        </header>

        <div class="bbi-modal-field">
          <span class="bbi-modal-label">名称</span>
          <input class="bbi-input" type="text" v-model="draft.name" placeholder="方案名称" spellcheck="false" />
        </div>

        <div class="bbi-select-row">
          <span class="bbi-field-label">接入点</span>
          <BbiSelect
            v-model="draft.endpointId"
            :options="conn.endpoints.map(e => ({ value: e.id, label: e.name || '未命名站点' }))"
            aria-label="方案接入点"
          />
        </div>

        <div class="bbi-select-row">
          <span class="bbi-field-label">模型</span>
          <BbiSelect
            v-model="draft.model"
            :options="NAI_MODELS"
            aria-label="方案模型"
          />
        </div>

        <div class="bbi-select-row">
          <span class="bbi-field-label">画师串</span>
          <BbiSelect v-model="draftArtist" :options="artistOptions" aria-label="方案画师串" />
        </div>

        <div v-if="customArtist" class="bbi-modal-field">
          <span class="bbi-modal-label">自定义画师串(只存在这套方案里,不进库)</span>
          <BbiTextarea v-model="draft.artistPrompt" :rows="3" :max-rows="8" mono placeholder="artist:xxx, artist:yyy" />
        </div>

        <div class="bbi-modal-field">
          <span class="bbi-modal-label">正面质量词(留空 = 回落画师串/官方词)</span>
          <BbiTextarea v-model="draft.qualityTags" :rows="2" :max-rows="6" mono />
        </div>

        <div class="bbi-modal-field">
          <span class="bbi-modal-label">负面提示词(留空 = 回落画师串/官方词)</span>
          <BbiTextarea v-model="draft.undesiredContent" :rows="2" :max-rows="6" mono />
        </div>

        <div v-if="conn.vibes.length" class="npl-vibes">
          <span class="bbi-modal-label">Vibe 叠加</span>
          <div class="npl-vibe-list">
            <label v-for="vibe in conn.vibes" :key="vibe.id" class="npl-vibe-item">
              <input
                type="checkbox"
                class="bbi-checkbox"
                :checked="draft.vibeIds.includes(vibe.id)"
                @change="toggleDraftVibe(vibe.id)"
              />
              {{ vibe.name || '未命名 Vibe' }}
            </label>
          </div>
        </div>

        <div class="be-grid">
          <div class="bbi-field">
            <div class="bbi-field-head"><span class="bbi-field-label">采样器</span></div>
            <BbiSelect v-model="draft.sampler" :options="draftSamplerOptions" aria-label="方案采样器" />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head"><span class="bbi-field-label">噪声表</span></div>
            <BbiSelect v-model="draft.noiseSchedule" :options="NOISE_OPTIONS" aria-label="方案噪声表" />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head"><span class="bbi-field-label">步数</span></div>
            <input class="bbi-input" type="number" v-model.number="draft.steps" min="1" max="50" />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head"><span class="bbi-field-label">Scale</span></div>
            <input class="bbi-input" type="number" v-model.number="draft.scale" min="0" max="35" step="0.1" />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head"><span class="bbi-field-label">Rescale</span></div>
            <input class="bbi-input" type="number" v-model.number="draft.cfgRescale" min="0" max="1" step="0.05" />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head"><span class="bbi-field-label">种子</span></div>
            <input class="bbi-input" type="number" v-model.number="draft.seed" min="0" />
          </div>
        </div>

        <div class="be-row">
          <div class="bbi-field">
            <div class="bbi-field-head"><span class="bbi-field-label">竖屏尺寸</span></div>
            <input class="bbi-input" type="text" v-model="draft.portraitSize" spellcheck="false" />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head"><span class="bbi-field-label">横屏尺寸</span></div>
            <input class="bbi-input" type="text" v-model="draft.landscapeSize" spellcheck="false" />
          </div>
        </div>

        <div class="bbi-select-row">
          <span class="bbi-field-label">画幅方向</span>
          <div class="bbi-segmented" role="tablist" aria-label="方案画幅方向">
            <button
              v-for="opt in ORIENTATION_LOCKS"
              :key="opt.value"
              class="bbi-seg"
              :class="{ 'is-on': draft.orientationLock === opt.value }"
              type="button"
              role="tab"
              :aria-selected="draft.orientationLock === opt.value"
              @click="draft.orientationLock = opt.value"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">生成自然语言</span>
          <input v-model="draft.naturalLanguage" type="checkbox" class="bbi-checkbox" />
        </label>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">Variety Boost</span>
          <input v-model="draft.varietyBoost" type="checkbox" class="bbi-checkbox" />
        </label>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">强度归一化</span>
          <input v-model="draft.normalizeRefStrength" type="checkbox" class="bbi-checkbox" />
        </label>

        <div class="npl-preview">
          <img
            v-if="draft.previewPath"
            class="npl-thumb"
            :src="artistPreviewSrc(draft)"
            :alt="draft.name"
          />
          <div v-else class="npl-thumb npl-thumb--empty"><Icon name="palette" :size="20" /></div>
          <div class="npl-preview-ops">
            <BbiTextarea v-model="draft.previewPrompt" :rows="2" :max-rows="4" mono placeholder="示例提示词" />
            <div class="npl-preview-btns">
              <button class="bbi-btn bbi-btn-sm" type="button" :disabled="!!previewBusy" @click="generatePreview(draft)">
                <Icon name="generate" :size="12" />
                {{ previewBusy === draft.id ? '生成中…' : '生成预览图' }}
              </button>
              <button v-if="previewBusy === draft.id" class="bbi-btn bbi-btn-sm" type="button" @click="previewAbort?.abort()">
                取消
              </button>
              <button class="bbi-btn bbi-btn-sm" type="button" :disabled="!!previewBusy" @click="pickPreview(draft)">
                <Icon name="upload" :size="12" /> 上传
              </button>
              <button
                v-if="draft.previewPath"
                class="bbi-btn bbi-btn-sm bbi-btn-danger"
                type="button"
                :disabled="!!previewBusy"
                @click="removePreview(draft)"
              >
                移除
              </button>
            </div>
          </div>
        </div>

        <footer class="bbi-modal-foot">
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn" type="button" @click="cancelEdit">取消</button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="saveEdit">保存</button>
        </footer>
      </div>
    </ModalMask>

    <input ref="previewFileInput" type="file" accept="image/*" hidden @change="onPreviewFileChange" />
  </div>
</template>

<style scoped>
.npl-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 10px;
}

.npl-card {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface);
  overflow: hidden;
  cursor: pointer;
  transition:
    border-color var(--bbi-dur) var(--bbi-ease),
    box-shadow var(--bbi-dur) var(--bbi-ease);
}

.npl-card:hover {
  border-color: var(--bbi-accent);
}

.npl-card.is-on {
  border-color: var(--bbi-accent);
  box-shadow: 0 0 0 1px var(--bbi-accent);
}

.npl-art {
  position: relative;
  aspect-ratio: 4 / 3;
  background: var(--bbi-surface-2);
}

.npl-art-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.npl-art-empty {
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

.npl-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  padding: 1px 6px;
  border-radius: var(--bbi-radius-pill);
  font-size: 10px;
  background: oklch(0 0 0 / 0.55);
  color: oklch(1 0 0 / 0.92);
}

.npl-badge.is-on {
  background: var(--bbi-accent);
  color: var(--bbi-on-accent, #fff);
}

.npl-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px 10px;
}

.npl-name {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.npl-meta {
  font-size: 11px;
  color: var(--bbi-ink-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.npl-ops {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 2px;
}

.npl-add {
  margin-top: 10px;
}

.npl-vibes {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 8px 0;
}

.npl-vibe-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
}

.npl-vibe-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}

.npl-preview {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  margin: 10px 0;
}

.npl-thumb {
  width: 132px;
  aspect-ratio: 4 / 3;
  object-fit: cover;
  border-radius: var(--bbi-radius);
  border: 1px solid var(--bbi-line);
  background: var(--bbi-surface-2);
}

.npl-thumb--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--bbi-ink-soft);
}

.npl-preview-ops {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.npl-preview-btns {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.be-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0 12px;
}

.be-row {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0 12px;
}

@media (max-width: 640px) {
  .be-grid,
  .be-row {
    grid-template-columns: 1fr;
  }
}
</style>
