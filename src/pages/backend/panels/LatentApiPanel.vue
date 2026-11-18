<script setup lang="ts">
import { computed, ref } from 'vue';
import BbiSelect from '@/components/BbiSelect.vue';
import BbiTextarea from '@/components/BbiTextarea.vue';
import Collapsible from '@/components/Collapsible.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { naiRandomSeed } from '@/backends/nai';
import {
  generateLatentApiImage,
  LATENT_API_MODEL,
  LatentPromptTooLongError,
  testLatentApiConnection,
} from '@/backends/latentApi';
import { artistPreviewSrc, bumpArtistPreview } from '@/pages/backend/panels/artistPreview';
import { makeJpegThumbnail, readFileAsDataUrl } from '@/st/imageFile';
import { deleteUserImage, LATENT_PROFILE_PREVIEW_FOLDER, uploadUserImage } from '@/st/images';
import {
  activeLatentApiProfile,
  LATENT_API_ORIENTATION_LOCKS,
  LATENT_API_SAMPLERS,
  LATENT_API_SCHEDULERS,
  LATENT_API_STEPS,
  latentApiProfileToConn,
  newLatentApiProfile,
  setActiveLatentApiProfile,
  settings,
  syncLatentApiMirror,
  type LatentApiProfile,
  type LatentApiSampler,
  type LatentApiScheduler,
} from '@/state/settings';

/**
 * 「Latent 原生 API」渠道面板(旧 Latent 页签已移除,这是唯一的 Latent 渠道)。
 *
 * 配置库:每套配置 = 出图参数 + 正/负面词 + 提示词规范/思维链 + 一张预览图。
 * 点卡片切换,✎ 编辑;预览图用该配置真实出一张图,落 user/images/柏宝绘_Latent配置/,
 * 只当封面(不进图库/历史),删配置时连带删文件。
 */
const showKey = ref(false);
const testing = ref(false);

const inUse = computed(() => settings.defaultBackend === 'latentapi');
const conn = computed(() => settings.latentApi);
const profiles = computed(() => conn.value.profiles);
const activeId = computed(() => activeLatentApiProfile(conn.value).id);

const SAMPLER_OPTIONS = LATENT_API_SAMPLERS.map(value => ({ value, label: value }));
const SCHEDULER_OPTIONS = LATENT_API_SCHEDULERS.map(value => ({ value, label: value }));

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return '操作已取消';
  return error instanceof Error ? error.message : String(error);
}

function lockLabel(lock: string): string {
  return LATENT_API_ORIENTATION_LOCKS.find(option => option.value === lock)?.label ?? lock;
}

/* ============ 配置切换 / 新建 / 复制 / 删除 ============ */

function switchProfile(id: string): void {
  setActiveLatentApiProfile(id, conn.value);
}

function addProfile(): void {
  const profile = newLatentApiProfile(`配置 ${conn.value.profiles.length + 1}`);
  conn.value.profiles.push(profile);
  setActiveLatentApiProfile(profile.id, conn.value);
  toastr.success(`已新建「${profile.name}」`, 'Latent 配置');
}

function duplicateProfile(source: LatentApiProfile): void {
  const copy: LatentApiProfile = { ...source, id: newLatentApiProfile().id, name: `${source.name} 副本` };
  delete copy.previewPath; // 预览图不随副本走,避免两条目共指一个文件
  const index = conn.value.profiles.findIndex(p => p.id === source.id);
  conn.value.profiles.splice(index + 1, 0, copy);
  setActiveLatentApiProfile(copy.id, conn.value);
  toastr.success(`已复制为「${copy.name}」`, 'Latent 配置');
}

async function deleteProfile(target: LatentApiProfile): Promise<void> {
  if (conn.value.profiles.length <= 1) return;
  const index = conn.value.profiles.findIndex(p => p.id === target.id);
  if (index < 0) return;
  conn.value.profiles.splice(index, 1);
  const next = conn.value.profiles[Math.min(index, conn.value.profiles.length - 1)];
  setActiveLatentApiProfile(next.id, conn.value);
  if (target.previewPath) {
    try {
      await deleteUserImage(target.previewPath);
    } catch (error) {
      toastr.warning(`配置已删除,但预览图文件清理失败：${errorMessage(error)}`, 'Latent 配置');
    }
  }
  toastr.success(`已删除「${target.name}」`, 'Latent 配置');
}

/* ============ 编辑弹窗(草稿态,保存才写回) ============ */

const editing = ref<LatentApiProfile | null>(null);
const draft = ref<LatentApiProfile | null>(null);

function openEdit(profile: LatentApiProfile): void {
  editing.value = profile;
  draft.value = { ...profile };
}

function cancelEdit(): void {
  editing.value = null;
  draft.value = null;
}

function saveEdit(): void {
  const target = editing.value;
  const value = draft.value;
  if (!target || !value) return;
  Object.assign(target, value);
  if (target.id === activeId.value) syncLatentApiMirror(conn.value);
  editing.value = null;
  draft.value = null;
  toastr.success(`已保存「${target.name}」`, 'Latent 配置');
}

/** 草稿里的采样器/调度器走 BbiSelect(string),写入前对一遍名单。 */
const draftSampler = computed<string>({
  get: () => draft.value?.sampler ?? 'euler',
  set: value => {
    if (draft.value && (LATENT_API_SAMPLERS as readonly string[]).includes(value)) {
      draft.value.sampler = value as LatentApiSampler;
    }
  },
});
const draftScheduler = computed<string>({
  get: () => draft.value?.scheduler ?? 'sgm_uniform',
  set: value => {
    if (draft.value && (LATENT_API_SCHEDULERS as readonly string[]).includes(value)) {
      draft.value.scheduler = value as LatentApiScheduler;
    }
  },
});

/* ============ 预览图:用该配置真实出一张 ============ */

const previewBusy = ref<string | null>(null);
const previewAbort = ref<AbortController | null>(null);

function blobUrlToJpegBase64(url: string): Promise<string> {
  return fetch(url)
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
    .then(dataUrl => makeJpegThumbnail(dataUrl, 512, 0.85));
}

async function generatePreview(profile: LatentApiProfile): Promise<void> {
  if (previewBusy.value) return;
  if (!conn.value.key.trim()) {
    toastr.error('请先填写 API Key', 'Latent 配置');
    return;
  }
  if (!profile.previewPrompt.trim()) {
    toastr.error('请先填写示例提示词', 'Latent 配置');
    return;
  }
  previewBusy.value = profile.id;
  const controller = new AbortController();
  previewAbort.value = controller;
  let resultUrl = '';
  try {
    const out = await generateLatentApiImage(
      latentApiProfileToConn(profile, conn.value),
      {
        prompt: profile.previewPrompt,
        nl: '',
        characters: [],
        seed: profile.seed > 0 ? profile.seed : naiRandomSeed(),
        size: profile.orientationLock === 'auto' ? 'portrait' : profile.orientationLock,
      },
      controller.signal,
    );
    resultUrl = out.result.url;
    const jpeg = await blobUrlToJpegBase64(resultUrl);
    const base64 = jpeg.split(',')[1] ?? '';
    profile.previewPath = await uploadUserImage(LATENT_PROFILE_PREVIEW_FOLDER, profile.id, base64, 'jpg');
    bumpArtistPreview(profile.id);
    toastr.success(`「${profile.name}」预览图已更新`, 'Latent 配置');
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      toastr.info('已取消生成预览图', 'Latent 配置');
    } else if (error instanceof LatentPromptTooLongError) {
      toastr.error(`提示词 ${error.length} 字,超过上限 ${error.limit},请删减示例提示词`, 'Latent 配置');
    } else {
      toastr.error(errorMessage(error), '生成预览图失败');
    }
  } finally {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    previewBusy.value = null;
    previewAbort.value = null;
  }
}

function cancelPreview(): void {
  previewAbort.value?.abort();
}

const previewFileInput = ref<HTMLInputElement | null>(null);

function pickPreviewFile(): void {
  previewFileInput.value?.click();
}

async function onPreviewFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || !draft.value) return;
  try {
    const dataUrl = await readFileAsDataUrl(file);
    const jpeg = await makeJpegThumbnail(dataUrl, 512, 0.85);
    const base64 = jpeg.split(',')[1] ?? '';
    draft.value.previewPath = await uploadUserImage(
      LATENT_PROFILE_PREVIEW_FOLDER,
      draft.value.id,
      base64,
      'jpg',
    );
    bumpArtistPreview(draft.value.id);
  } catch (error) {
    toastr.error(errorMessage(error), '预览图上传失败');
  }
}

async function removePreview(profile: LatentApiProfile): Promise<void> {
  const path = profile.previewPath;
  if (!path) return;
  profile.previewPath = undefined;
  try {
    await deleteUserImage(path);
  } catch (error) {
    toastr.warning(`预览图引用已移除,但文件清理失败：${errorMessage(error)}`, 'Latent 配置');
  }
}

/* ============ 连接 ============ */

async function onTestConnection(): Promise<void> {
  if (testing.value) return;
  testing.value = true;
  try {
    const result = await testLatentApiConnection(conn.value);
    toastr.success(result.message, 'Latent 原生 API');
  } catch (error) {
    toastr.error(errorMessage(error), 'Latent 原生 API 连接失败');
  } finally {
    testing.value = false;
  }
}
</script>

<template>
  <div class="panel">
    <p class="bbi-page-intro">
      latent.moe 自己的生图接口(模型 {{ LATENT_API_MODEL }})。配置库保存每套画风的出图参数与提示词写法;
      点卡片切换,预览图用该配置真实出一张。
    </p>

    <div class="bbi-sections">
      <Collapsible title="配置库" :open="true">
        <div class="lap-grid">
          <div
            v-for="p in profiles"
            :key="p.id"
            class="lap-card"
            :class="{ 'is-on': p.id === activeId }"
            role="button"
            tabindex="0"
            @click="switchProfile(p.id)"
            @keydown.enter="switchProfile(p.id)"
          >
            <div class="lap-art">
              <img
                v-if="p.previewPath"
                class="lap-art-img"
                :src="artistPreviewSrc(p)"
                :alt="p.name"
                loading="lazy"
                decoding="async"
              />
              <div v-else class="lap-art-empty">
                <Icon name="generate" :size="20" />
                <span>出图后自动出现</span>
              </div>
              <span v-if="p.id === activeId" class="lap-badge is-on">使用中</span>
            </div>
            <div class="lap-body">
              <div class="lap-name">{{ p.name || '未命名配置' }}</div>
              <div class="lap-meta">{{ p.steps }}步 · {{ p.sampler }} · {{ lockLabel(p.orientationLock) }}</div>
              <div class="lap-ops" @click.stop>
                <button class="bbi-btn bbi-btn-sm" type="button" @click="openEdit(p)">
                  <Icon name="edit" :size="12" /> 编辑
                </button>
                <button class="bbi-btn bbi-btn-sm" type="button" @click="duplicateProfile(p)">
                  <Icon name="copy" :size="12" /> 复制
                </button>
                <button
                  class="bbi-btn bbi-btn-sm bbi-btn-danger"
                  type="button"
                  :disabled="profiles.length <= 1"
                  @click="deleteProfile(p)"
                >
                  <Icon name="trash" :size="12" /> 删除
                </button>
              </div>
            </div>
          </div>
        </div>
        <button class="bbi-btn bbi-btn-sm lap-add" type="button" @click="addProfile">
          <Icon name="plus" :size="12" /> 新建配置
        </button>
      </Collapsible>

      <Collapsible title="连接" :open="false">
        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">站点地址</span>
          </div>
          <input class="bbi-input" type="text" v-model="conn.url" placeholder="https://latent.moe" spellcheck="false" />
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">API Key</span>
          </div>
          <div class="key-row">
            <input
              class="bbi-input"
              :type="showKey ? 'text' : 'password'"
              v-model="conn.key"
              placeholder="lat_sk_..."
              spellcheck="false"
            />
            <button class="bbi-btn" type="button" :title="showKey ? '隐藏' : '显示'" @click="showKey = !showKey">
              <Icon :name="showKey ? 'eye-off' : 'eye'" />
            </button>
          </div>
        </div>

        <div class="conn-actions">
          <span v-if="inUse" class="conn-inuse"><Icon name="check" :size="13" /> 当前出图渠道</span>
          <button
            v-else
            class="bbi-btn conn-use"
            type="button"
            title="tag 书写规范会切到 Latent 原生 API"
            @click="settings.defaultBackend = 'latentapi'"
          >
            使用此渠道出图
          </button>
          <button class="bbi-btn" type="button" :disabled="testing" @click="onTestConnection">
            <Icon name="plug" />
            {{ testing ? '连接中…' : '测试连接' }}
          </button>
        </div>
        <p class="bbi-field-hint warn-note">
          站点不允许浏览器直接调用,请求一律经酒馆转发:需要在酒馆的 config.yaml 里设
          <code>enableCorsProxy: true</code> 并重启酒馆。Key 只经过你自己的酒馆服务器。
        </p>
      </Collapsible>
    </div>

    <!-- ===== 配置编辑弹窗:参数 / 提示词 / 预览图 ===== -->
    <ModalMask :open="!!draft" @close="cancelEdit">
      <div v-if="draft" class="bbi-modal lap-edit" role="dialog" aria-modal="true" aria-label="编辑 Latent 配置">
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">编辑配置</span>
          <button class="bbi-icon-mini" type="button" title="关闭" aria-label="关闭" @click="cancelEdit">
            <Icon name="close" />
          </button>
        </header>

        <div class="bbi-modal-field">
          <span class="bbi-modal-label">名称</span>
          <input class="bbi-input" type="text" v-model="draft.name" placeholder="配置名称" spellcheck="false" />
        </div>

        <div class="bbi-select-row">
          <span class="bbi-field-label">画幅方向</span>
          <div class="bbi-segmented" role="tablist" aria-label="Latent 画幅方向">
            <button
              v-for="opt in LATENT_API_ORIENTATION_LOCKS"
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

        <div class="be-grid">
          <div class="bbi-field">
            <div class="bbi-field-head"><span class="bbi-field-label">采样器</span></div>
            <BbiSelect v-model="draftSampler" :options="SAMPLER_OPTIONS" aria-label="采样器" />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head"><span class="bbi-field-label">调度器</span></div>
            <BbiSelect v-model="draftScheduler" :options="SCHEDULER_OPTIONS" aria-label="调度器" />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head"><span class="bbi-field-label">步数</span></div>
            <input
              class="bbi-input"
              type="number"
              v-model.number="draft.steps"
              :min="LATENT_API_STEPS.min"
              :max="LATENT_API_STEPS.max"
            />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head"><span class="bbi-field-label">种子</span></div>
            <input class="bbi-input" type="number" v-model.number="draft.seed" min="0" />
          </div>
        </div>
        <p class="bbi-field-hint">步数 {{ LATENT_API_STEPS.min }}–{{ LATENT_API_STEPS.max }};种子 0 = 每张随机。</p>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">生成自然语言</span>
          <input v-model="draft.naturalLanguage" type="checkbox" class="bbi-checkbox" />
        </label>

        <div class="bbi-modal-field">
          <span class="bbi-modal-label">正向前缀(拼在 Scene 最前)</span>
          <input class="bbi-input" type="text" v-model="draft.positivePrefix" spellcheck="false" />
        </div>

        <div class="bbi-modal-field">
          <span class="bbi-modal-label">负面提示词</span>
          <BbiTextarea v-model="draft.negativePrompt" :rows="2" :max-rows="6" mono />
        </div>

        <div class="bbi-modal-field">
          <span class="bbi-modal-label">书写规范(留空 = 用设置页的全局规范)</span>
          <BbiTextarea v-model="draft.spec" :rows="4" :max-rows="12" mono />
        </div>

        <div class="bbi-modal-field">
          <span class="bbi-modal-label">思维链(留空 = 用设置页的全局思维链)</span>
          <BbiTextarea v-model="draft.thinking" :rows="4" :max-rows="12" mono />
        </div>

        <div class="bbi-modal-field">
          <span class="bbi-modal-label">示例提示词(生成预览图用,Scene 串)</span>
          <BbiTextarea v-model="draft.previewPrompt" :rows="2" :max-rows="6" mono />
        </div>

        <div class="lap-preview">
          <img v-if="draft.previewPath" class="lap-thumb" :src="artistPreviewSrc(draft)" :alt="draft.name" />
          <div v-else class="lap-thumb lap-thumb--empty"><Icon name="generate" :size="20" /></div>
          <div class="lap-preview-ops">
            <button
              class="bbi-btn bbi-btn-sm"
              type="button"
              :disabled="!!previewBusy"
              @click="generatePreview(draft)"
            >
              <Icon name="generate" :size="12" />
              {{ previewBusy === draft.id ? '生成中…' : '生成预览图' }}
            </button>
            <button v-if="previewBusy === draft.id" class="bbi-btn bbi-btn-sm" type="button" @click="cancelPreview">
              取消
            </button>
            <button class="bbi-btn bbi-btn-sm" type="button" :disabled="!!previewBusy" @click="pickPreviewFile">
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
        <p class="bbi-field-hint">
          平时用这套配置出图时会<strong>自动取一张当封面</strong>（不额外消耗）；这里的「生成预览图」是用示例提示词主动再出一张，
          会消耗一次额度，可取消。图片只当配置封面，不进图库。
        </p>

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
.lap-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 10px;
}

.lap-card {
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

.lap-card:hover {
  border-color: var(--bbi-accent);
}

.lap-card.is-on {
  border-color: var(--bbi-accent);
  box-shadow: 0 0 0 1px var(--bbi-accent);
}

.lap-art {
  position: relative;
  aspect-ratio: 4 / 3;
  background: var(--bbi-surface-2);
}

.lap-art-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.lap-art-empty {
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

.lap-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  padding: 1px 6px;
  border-radius: var(--bbi-radius-pill);
  font-size: 10px;
  background: oklch(0 0 0 / 0.55);
  color: oklch(1 0 0 / 0.92);
}

.lap-badge.is-on {
  background: var(--bbi-accent);
  color: var(--bbi-on-accent, #fff);
}

.lap-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px 10px;
}

.lap-name {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lap-meta {
  font-size: 11px;
  color: var(--bbi-ink-soft);
}

.lap-ops {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 2px;
}

.lap-add {
  margin-top: 10px;
}

.lap-preview {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  margin: 10px 0;
}

.lap-thumb {
  width: 132px;
  aspect-ratio: 4 / 3;
  object-fit: cover;
  border-radius: var(--bbi-radius);
  border: 1px solid var(--bbi-line);
  background: var(--bbi-surface-2);
}

.lap-thumb--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--bbi-ink-soft);
}

.lap-preview-ops {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.be-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0 12px;
}

@media (max-width: 640px) {
  .be-grid {
    grid-template-columns: 1fr;
  }
}

.key-row {
  display: flex;
  gap: 8px;
}

.key-row .bbi-input {
  flex: 1 1 auto;
  min-width: 0;
}

.conn-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  margin-top: 12px;
}

.conn-use,
.conn-inuse {
  margin-right: auto;
}

.conn-inuse {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--bbi-accent);
}

.warn-note {
  margin-top: 6px;
  border-left: 2px solid var(--bbi-accent);
  padding-left: 8px;
}
</style>
