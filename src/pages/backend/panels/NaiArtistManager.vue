<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  applyNaiPresetParams,
  matchArtist,
  planArtistRemoval,
  snapshotNaiPresetParams,
} from '@/backends/naiArtistLib';
import { buildPresetExportFile, importPresetFile } from '@/backends/naiPresetFile';
import { BUILTIN_NAI_ARTISTS } from '@/backends/nai';
import BbiTextarea from '@/components/BbiTextarea.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { makeJpegThumbnail, readFileAsDataUrl } from '@/st/imageFile';
import { ARTIST_PREVIEW_FOLDER, deleteUserImage, uploadUserImage } from '@/st/images';
import { newNaiArtist, settings, type NaiArtistPreset } from '@/state/settings';

/**
 * 画师串库管理器(NAI 面板「管理」按钮唤起)。
 *
 * 分工:面板里的下拉管「高频切换」,这里管「低频管理」——搜索、预览图、
 * 勾选批量删除、逐条编辑/复制/删除。
 *
 * 交互约定:
 * - 点卡片主体 = 启用该条(再点当前条 = 停用,回「不使用」);
 * - 左上角勾选框 = 管理态多选,只服务于批量删除,与启用状态无关;
 * - 内置条(bi_*)随插件版本更新,只读:无勾选框、不可删改,「复制」是唯一自定义入口;
 * - 预览图上传后压成最长边 512 的 jpeg,落 user/images/柏宝绘_画师串/<条目id>.jpg,
 *   路径记在条目 previewPath 上,不维护额外索引;换图同名覆盖,删条目时连带删文件。
 */

/**
 * target:本管理器服务哪条渠道的配方库(NAI / latent 各一份,互不影响)。
 * 默认 'nai',故既有用法不用改。理由同 NaiPanel —— 协议相同,照抄 900 行等于维护两遍。
 */
const props = withDefaults(defineProps<{ open: boolean; target?: 'nai' | 'latent' }>(), {
  target: 'nai',
});
const emit = defineEmits<{ (e: 'update:open', v: boolean): void }>();

/** 本渠道的设置对象。所有读写一律走它,别直接碰 settings 上的具体渠道字段。 */
const conn = computed(() => (props.target === 'latent' ? settings.latent : settings.nai));

function close() {
  emit('update:open', false);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 列表条目:内置库排前(与下拉的顺序一致),附带只读标记。 */
interface ManagerItem {
  preset: NaiArtistPreset;
  builtin: boolean;
}

const search = ref('');
/** 管理态勾选集(只存用户条目 id;内置条不可勾选,天然进不来)。 */
const selected = ref<ReadonlySet<string>>(new Set());

// 每次打开回到干净状态:搜索词与勾选都是「这一轮管理」的临时态,不该跨次残留。
watch(
  () => props.open,
  open => {
    if (!open) return;
    search.value = '';
    selected.value = new Set();
  },
);

const items = computed<ManagerItem[]>(() => [
  ...BUILTIN_NAI_ARTISTS.map(p => ({ preset: p, builtin: true })),
  ...conn.value.artistPresets.map(p => ({ preset: p, builtin: false })),
]);

const filtered = computed(() => items.value.filter(i => matchArtist(i.preset, search.value)));

/** 当前筛选结果里的可勾选(用户)条目:全选/计数都以它为准,内置条不参与批量。 */
const selectableFiltered = computed(() => filtered.value.filter(i => !i.builtin));

const allFilteredSelected = computed(
  () =>
    selectableFiltered.value.length > 0 &&
    selectableFiltered.value.every(i => selected.value.has(i.preset.id)),
);

const activeId = computed(() => conn.value.activeArtistId);

/** 点卡片:启用;再点当前条:停用(回「不使用」,是有意义的存储值)。 */
function toggleActive(item: ManagerItem) {
  conn.value.activeArtistId = item.preset.id === activeId.value ? '' : item.preset.id;
}

function toggleSelect(id: string) {
  const next = new Set(selected.value);
  if (!next.delete(id)) next.add(id);
  selected.value = next;
}

function toggleSelectAllFiltered() {
  const next = new Set(selected.value);
  if (allFilteredSelected.value) {
    for (const i of selectableFiltered.value) next.delete(i.preset.id);
  } else {
    for (const i of selectableFiltered.value) next.add(i.preset.id);
  }
  selected.value = next;
}

/** 新建:入库 + 设为当前 + 直接开编辑弹窗,一步到位。 */
function addArtist() {
  const preset = newNaiArtist(`画师串 ${conn.value.artistPresets.length + 1}`);
  conn.value.artistPresets.push(preset);
  conn.value.activeArtistId = preset.id;
  openEdit({ preset, builtin: false });
}

/**
 * 复制:预览图不随副本走——预览文件随原条目删除,共指一个路径会让副本日后破图。
 * 也不切换当前条:管理器里复制常用于批量攒变体,启用哪条由用户点卡片明示。
 */
function duplicate(item: ManagerItem) {
  const src = item.preset;
  const preset: NaiArtistPreset = {
    id: newNaiArtist().id,
    name: `${src.name} 副本`,
    prompt: src.prompt,
    quality: src.quality,
    negative: src.negative,
    vibes: src.vibes?.map(ref => ({ ...ref })),
    params: src.params ? { ...src.params } : undefined,
  };
  conn.value.artistPresets.push(preset);
  toastr.success(`已复制为「${preset.name}」`, '画师串');
}

/* ============ 预设文件导入/导出(与智绘姬互通) ============ */

const importing = ref(false);
const exporting = ref(false);
const importFileInput = ref<HTMLInputElement | null>(null);

function exportFileName(): string {
  return `柏宝绘-画师串-${new Date().toISOString().slice(0, 10)}.json`;
}

function downloadJson(text: string, filename: string) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

async function exportPresets() {
  const presets = conn.value.artistPresets;
  if (!presets.length) {
    toastr.warning('还没有画师串可导出', '画师串');
    return;
  }
  exporting.value = true;
  try {
    const result = await buildPresetExportFile({
      presets,
      vibes: conn.value.vibes,
      fallbackParams: snapshotNaiPresetParams(conn.value),
    });
    downloadJson(result.json, exportFileName());
    const parts = [`${result.counts.presets} 个画师串`];
    if (result.counts.vibes) parts.push(`${result.counts.vibes} 条 Vibe`);
    if (result.counts.previews) parts.push(`${result.counts.previews} 张预览图`);
    toastr.success(`已导出 ${parts.join('、')}`, '画师串');
    if (result.warnings.length) toastr.warning(result.warnings[0], '导出提示');
  } catch (error) {
    toastr.error(errorMessage(error), '导出失败');
  } finally {
    exporting.value = false;
  }
}

function pickImportFile() {
  if (importing.value) return;
  importFileInput.value?.click();
}

async function onImportFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  importing.value = true;
  try {
    const result = await importPresetFile({
      text: await file.text(),
      existingPresets: conn.value.artistPresets,
      existingVibes: conn.value.vibes,
      model: conn.value.model,
    });
    conn.value.artistPresets = result.presets;
    conn.value.vibes = result.vibes;
    // 覆盖导入可能换掉同名预览图,URL 不变时浏览器会继续显示旧图;统一 bump 破缓存
    const versions = new Map(previewVersions.value);
    for (const preset of result.presets) {
      if (preset.previewPath) versions.set(preset.id, Date.now());
    }
    previewVersions.value = versions;
    const parts = [`新增 ${result.imported} 个`, `覆盖 ${result.overwritten} 个`];
    if (result.skipped) parts.push(`跳过 ${result.skipped} 个`);
    if (result.importedVibes) parts.push(`新增 ${result.importedVibes} 条 Vibe`);
    toastr.success(`导入完成：${parts.join('，')}`, '画师串');
    if (result.warnings.length) toastr.warning(result.warnings[0], '导入提示');
  } catch (error) {
    toastr.error(errorMessage(error), '导入失败');
  } finally {
    importing.value = false;
  }
}

/** 显式应用预设携带的模型参数;切换画师串本身不会静默改模型。 */
function applyParams(preset: NaiArtistPreset) {
  if (!preset.params) return;
  applyNaiPresetParams(conn.value, preset.params);
  toastr.success(`已应用「${preset.name}」的模型参数`, '画师串');
}

/* ============ 预览图 ============ */

/** 预览图最长边:卡片显示约 200px 宽,512 留足高分屏余量,又不把 user/images 撑大。 */
const PREVIEW_MAX_EDGE = 512;

const previewFileInput = ref<HTMLInputElement | null>(null);
/** 本次上传要为哪条换图;文件框是共享的一个,靠它在 change 时找回目标。 */
let previewTarget: NaiArtistPreset | null = null;
const uploadingId = ref<string | null>(null);

/**
 * 覆盖同名文件后 URL 不变,浏览器缓存会让卡片继续显示旧图;
 * 本组件内记一份 id → 版本号,上传成功后 bump,<img src> 带上 query 即可破缓存。
 */
const previewVersions = ref<ReadonlyMap<string, number>>(new Map());

function previewSrc(preset: NaiArtistPreset): string {
  if (!preset.previewPath) return '';
  const v = previewVersions.value.get(preset.id);
  return v ? `${preset.previewPath}?v=${v}` : preset.previewPath;
}

function pickPreview(preset: NaiArtistPreset) {
  if (uploadingId.value) return;
  previewTarget = preset;
  previewFileInput.value?.click();
}

async function onPreviewFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  const target = previewTarget;
  previewTarget = null;
  if (!file || !target) return;
  uploadingId.value = target.id;
  try {
    const dataUrl = await readFileAsDataUrl(file);
    const jpeg = await makeJpegThumbnail(dataUrl, PREVIEW_MAX_EDGE, 0.85);
    const base64 = jpeg.split(',')[1] ?? '';
    // 文件名 = 条目 id:换图同名覆盖,不会攒孤儿文件
    target.previewPath = await uploadUserImage(ARTIST_PREVIEW_FOLDER, target.id, base64, 'jpg');
    previewVersions.value = new Map(previewVersions.value).set(target.id, Date.now());
    toastr.success(`「${target.name || '未命名画师串'}」预览图已更新`, '画师串');
  } catch (error) {
    toastr.error(errorMessage(error), '预览图上传失败');
  } finally {
    uploadingId.value = null;
  }
}

/** 移除预览:先清字段(界面立即响应),文件删除 best-effort,失败只警告不回滚。 */
async function removePreview(preset: NaiArtistPreset) {
  const path = preset.previewPath;
  if (!path) return;
  preset.previewPath = undefined;
  try {
    await deleteUserImage(path);
  } catch (error) {
    toastr.warning(`预览图引用已移除,但文件清理失败：${errorMessage(error)}`, '画师串');
  }
}

/* ============ 删除(单条与批量共用确认弹窗) ============ */

const deleteOpen = ref(false);
const deleteList = ref<NaiArtistPreset[]>([]);
const deleting = ref(false);

function askDelete(presets: NaiArtistPreset[]) {
  if (!presets.length) return;
  deleteList.value = presets;
  deleteOpen.value = true;
}

function askDeleteSelected() {
  const byId = new Map(conn.value.artistPresets.map(p => [p.id, p]));
  askDelete([...selected.value].map(id => byId.get(id)).filter((p): p is NaiArtistPreset => !!p));
}

async function confirmDelete() {
  if (deleting.value) return;
  deleting.value = true;
  const ids = new Set(deleteList.value.map(p => p.id));
  const plan = planArtistRemoval(conn.value.artistPresets, ids, activeId.value);
  // 预览文件清理 best-effort:文件没删掉不阻塞删条目(孤儿文件可手动清,条目删不掉才烦人)
  let fileFailures = 0;
  for (const p of plan.removed) {
    if (!p.previewPath) continue;
    try {
      await deleteUserImage(p.previewPath);
    } catch {
      fileFailures += 1;
    }
  }
  conn.value.artistPresets = plan.remaining;
  conn.value.activeArtistId = plan.nextActiveId;
  const nextSelected = new Set(selected.value);
  for (const id of ids) nextSelected.delete(id);
  selected.value = nextSelected;
  deleteOpen.value = false;
  deleting.value = false;
  if (fileFailures) {
    toastr.warning(
      `已删除 ${plan.removed.length} 条,但 ${fileFailures} 张预览图文件清理失败`,
      '画师串',
    );
  } else {
    toastr.success(`已删除 ${plan.removed.length} 条画师串`, '画师串');
  }
}

/* ============ 编辑/查看弹窗(内置条只读) ============ */

const editItem = ref<ManagerItem | null>(null);
const editName = ref('');
const editPrompt = ref('');

function openEdit(item: ManagerItem) {
  editItem.value = item;
  editName.value = item.preset.name;
  editPrompt.value = item.preset.prompt;
}

function closeEdit() {
  editItem.value = null;
}

function saveEdit() {
  const item = editItem.value;
  if (!item || item.builtin) return; // 内置只读(按钮已隐藏,双保险)
  item.preset.name = editName.value.trim();
  item.preset.prompt = editPrompt.value;
  closeEdit();
}

/** 编辑弹窗里复制内置条:副本入库后关掉查看窗,让用户回到网格看到新卡。 */
function duplicateFromEdit() {
  const item = editItem.value;
  if (!item) return;
  duplicate(item);
  closeEdit();
}
</script>

<template>
  <ModalMask :open="open" @close="close">
    <div class="bbi-modal am-modal" role="dialog" aria-modal="true" aria-label="画师串库">
      <header class="bbi-modal-head">
        <span class="bbi-modal-title">画师串库</span>
        <button class="bbi-icon-mini" type="button" title="关闭" aria-label="关闭" @click="close">
          <Icon name="close" />
        </button>
      </header>

      <div class="am-toolbar">
        <input
          class="bbi-input am-search"
          type="search"
          v-model="search"
          placeholder="搜索名称或画师串内容…"
          spellcheck="false"
          aria-label="搜索画师串"
        />
        <span class="am-count">共 {{ items.length }} 条</span>
        <button class="bbi-btn bbi-btn-sm" type="button" :disabled="exporting" @click="exportPresets">
          <Icon name="download" :size="12" /> {{ exporting ? '导出中…' : '导出' }}
        </button>
        <button class="bbi-btn bbi-btn-sm" type="button" :disabled="importing" @click="pickImportFile">
          <Icon name="upload" :size="12" /> {{ importing ? '导入中…' : '导入' }}
        </button>
        <button class="bbi-btn bbi-btn-primary" type="button" @click="addArtist">
          <Icon name="plus" /> 新建
        </button>
      </div>

      <div v-if="selected.size" class="am-batch">
        <span class="am-batch-count">已选 {{ selected.size }} 条</span>
        <button class="bbi-btn bbi-btn-sm" type="button" @click="toggleSelectAllFiltered">
          {{ allFilteredSelected ? '取消全选' : `全选当前结果(${selectableFiltered.length})` }}
        </button>
        <button class="bbi-btn bbi-btn-sm" type="button" @click="selected = new Set()">清空</button>
        <span class="am-batch-spacer"></span>
        <button
          class="bbi-btn bbi-btn-sm am-btn-danger"
          type="button"
          @click="askDeleteSelected"
        >
          <Icon name="trash" :size="12" /> 删除所选
        </button>
      </div>

      <div class="am-scroll">
        <p v-if="!filtered.length" class="am-empty">
          <template v-if="items.length">没有匹配「{{ search }}」的画师串。</template>
          <template v-else>还没有画师串,点右上角「新建」开始。</template>
        </p>

        <div v-else class="am-grid">
          <div
            v-for="item in filtered"
            :key="item.preset.id"
            class="am-card"
            :class="{
              'is-active': item.preset.id === activeId,
              'is-selected': selected.has(item.preset.id),
            }"
            :title="item.preset.id === activeId ? '当前画师串,点击停用' : '点击设为当前画师串'"
            @click="toggleActive(item)"
          >
            <div class="am-art">
              <img
                v-if="item.preset.previewPath"
                class="am-art-img"
                :src="previewSrc(item.preset)"
                :alt="item.preset.name"
                loading="lazy"
                decoding="async"
              />
              <button
                v-else-if="!item.builtin"
                class="am-art-empty"
                type="button"
                :disabled="uploadingId === item.preset.id"
                title="上传预览图"
                @click.stop="pickPreview(item.preset)"
              >
                <Icon name="generate" :size="20" />
                <span>{{ uploadingId === item.preset.id ? '上传中…' : '添加预览图' }}</span>
              </button>
              <div v-else class="am-art-empty am-art-empty--static">
                <Icon name="nai" :size="22" />
              </div>

              <label
                v-if="!item.builtin"
                class="am-check"
                title="勾选后可批量删除"
                @click.stop
              >
                <input
                  type="checkbox"
                  class="bbi-checkbox"
                  :checked="selected.has(item.preset.id)"
                  aria-label="选择此画师串"
                  @change="toggleSelect(item.preset.id)"
                />
              </label>

              <span v-if="item.preset.id === activeId" class="am-badge is-on">使用中</span>
              <span v-else-if="item.builtin" class="am-badge">内置</span>

              <button
                v-if="!item.builtin && item.preset.previewPath"
                class="am-art-change"
                type="button"
                :disabled="uploadingId === item.preset.id"
                @click.stop="pickPreview(item.preset)"
              >
                {{ uploadingId === item.preset.id ? '上传中…' : '更换预览图' }}
              </button>
            </div>

            <div class="am-body">
              <div class="am-name-row">
                <!-- 单选圈:明示「启用是单选切换」;整卡都可点,圈只是状态可视化和提示 -->
                <span
                  class="am-radio"
                  :class="{ 'is-on': item.preset.id === activeId }"
                  aria-hidden="true"
                >
                  <Icon v-if="item.preset.id === activeId" name="check" :size="9" />
                </span>
                <div class="am-name" :title="item.preset.name">
                  {{ item.preset.name || '未命名画师串' }}
                </div>
              </div>
              <div class="am-prompt" :title="item.preset.prompt">
                {{ item.preset.prompt || '(空)' }}
              </div>
              <div class="am-ops" @click.stop>
                <button
                  class="am-op"
                  type="button"
                  :title="item.builtin ? '查看内容(内置只读)' : '编辑名称与内容'"
                  :aria-label="item.builtin ? '查看内容' : '编辑'"
                  @click="openEdit(item)"
                >
                  <Icon name="edit" :size="13" />
                </button>
                <button
                  class="am-op"
                  type="button"
                  title="复制为我的画师串"
                  aria-label="复制"
                  @click="duplicate(item)"
                >
                  <Icon name="copy" :size="13" />
                </button>
                <button
                  v-if="!item.builtin"
                  class="am-op am-op-danger"
                  type="button"
                  title="删除"
                  aria-label="删除"
                  @click="askDelete([item.preset])"
                >
                  <Icon name="trash" :size="13" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <footer class="bbi-modal-foot am-foot">
        <span class="am-foot-hint">点卡片或单选圈启用/停用;勾选左上角方框可批量删除。</span>
        <span class="bbi-modal-foot-spacer"></span>
        <button class="bbi-btn" type="button" @click="close">关闭</button>
      </footer>
    </div>
  </ModalMask>

  <!-- 删除确认:单条与批量共用;叠在管理器之上 -->
  <ConfirmDialog
    v-model:open="deleteOpen"
    top-layer
    title="删除画师串"
    :confirm-text="deleting ? '删除中…' : '删除'"
    confirm-icon="trash"
    tone="danger"
    :busy="deleting"
    @confirm="confirmDelete"
  >
    <template v-if="deleteList.length === 1">
      确定删除画师串「{{ deleteList[0]?.name || '未命名画师串' }}」?删除后无法恢复。
    </template>
    <template v-else>
      确定删除选中的 {{ deleteList.length }} 条画师串?删除后无法恢复。
    </template>
  </ConfirmDialog>

  <!-- 编辑/查看:名称 + 内容 + 预览图;绑定的正/负面词仍在面板里随「当前条」编辑 -->
  <ModalMask :open="!!editItem" top-layer @close="closeEdit">
    <div
      v-if="editItem"
      class="bbi-modal am-edit"
      role="dialog"
      aria-modal="true"
      :aria-label="editItem.builtin ? '查看画师串' : '编辑画师串'"
    >
      <header class="bbi-modal-head">
        <span class="bbi-modal-title">{{ editItem.builtin ? '查看画师串(内置)' : '编辑画师串' }}</span>
        <button class="bbi-icon-mini" type="button" title="关闭" aria-label="关闭" @click="closeEdit">
          <Icon name="close" />
        </button>
      </header>

      <div class="am-edit-preview">
        <img
          v-if="editItem.preset.previewPath"
          class="am-edit-thumb"
          :src="previewSrc(editItem.preset)"
          :alt="editItem.preset.name"
        />
        <div v-else class="am-edit-thumb am-edit-thumb--empty"><Icon name="generate" /></div>
        <div v-if="!editItem.builtin" class="am-edit-preview-ops">
          <button
            class="bbi-btn bbi-btn-sm"
            type="button"
            :disabled="uploadingId === editItem.preset.id"
            @click="pickPreview(editItem.preset)"
          >
            <Icon name="upload" :size="12" />
            {{ uploadingId === editItem.preset.id ? '上传中…' : editItem.preset.previewPath ? '更换预览图' : '上传预览图' }}
          </button>
          <button
            v-if="editItem.preset.previewPath"
            class="bbi-btn bbi-btn-sm am-btn-danger"
            type="button"
            @click="removePreview(editItem.preset)"
          >
            <Icon name="trash" :size="12" /> 移除预览图
          </button>
        </div>
      </div>

      <div class="bbi-modal-field">
        <span class="bbi-modal-label">名称</span>
        <input
          class="bbi-input"
          type="text"
          v-model="editName"
          :readonly="editItem.builtin"
          placeholder="画师串名称"
          spellcheck="false"
        />
      </div>

      <div class="bbi-modal-field">
        <span class="bbi-modal-label">画师串(拼在正向提示词最前面)</span>
        <BbiTextarea
          v-model="editPrompt"
          :rows="4"
          :max-rows="12"
          mono
          :readonly="editItem.builtin"
          placeholder="artist:xxx, artist:yyy"
        />
      </div>

      <p class="bbi-modal-label">
        绑定的正面质量词「{{ editItem.preset.quality.trim() ? '已设置' : '未设置' }}」、负面提示词「{{
          editItem.preset.negative.trim() ? '已设置' : '未设置'
        }}」;要改它们,先在面板里把这条设为当前画师串,再点提示词区的对应行。
      </p>

      <p v-if="!editItem.builtin && editItem.preset.params" class="bbi-modal-label">
        携带模型参数:{{ editItem.preset.params.model }} · {{ editItem.preset.params.sampler }} ·
        {{ editItem.preset.params.steps }} 步 · CFG {{ editItem.preset.params.scale }}。
        应用会切换当前渠道的模型与采样参数。
      </p>
      <p v-if="!editItem.builtin && editItem.preset.vibes" class="bbi-modal-label">
        Vibe 绑定:{{
          editItem.preset.vibes.length ? `已绑定 ${editItem.preset.vibes.length} 条` : '明确不使用 Vibe'
        }};切换画师串时自动套用。
      </p>

      <footer class="bbi-modal-foot">
        <button class="bbi-btn" type="button" @click="toggleActive(editItem)">
          {{ editItem.preset.id === activeId ? '停用这条' : '设为当前画师串' }}
        </button>
        <template v-if="editItem.builtin">
          <button class="bbi-btn" type="button" @click="duplicateFromEdit">
            <Icon name="copy" /> 复制为我的画师串
          </button>
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="closeEdit">关闭</button>
        </template>
        <template v-else>
          <button
            v-if="editItem.preset.params"
            class="bbi-btn"
            type="button"
            title="把预设携带的模型与采样参数应用到当前渠道"
            @click="applyParams(editItem.preset)"
          >
            <Icon name="settings" :size="12" /> 应用参数
          </button>
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn" type="button" @click="closeEdit">取消</button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="saveEdit">完成</button>
        </template>
      </footer>
    </div>
  </ModalMask>

  <input
    ref="previewFileInput"
    type="file"
    accept="image/*"
    hidden
    @change="onPreviewFileChange"
  />
  <input
    ref="importFileInput"
    type="file"
    accept=".json,application/json"
    hidden
    @change="onImportFileChange"
  />
</template>

<style scoped>
/* 管理器弹窗:比通用弹窗宽一档装卡片网格;固定高度,网格区内滚,头/工具条/底栏钉住。
   .bbi-modal 默认 overflow-y:auto,这里改为 hidden,滚动交给 .am-scroll。 */
.am-modal {
  max-width: 760px;
  height: 86vh;
  height: 86dvh;
  overflow: hidden;
}

.am-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.am-search {
  flex: 1 1 auto;
  min-width: 0;
  padding: 6px 10px;
}
.am-count {
  font-size: 12px;
  color: var(--bbi-ink-muted);
  white-space: nowrap;
}

/* 批量操作条:有勾选时才出现,accent 浅底与常规内容分区 */
.am-batch {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 10px;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-accent-soft);
  font-size: 12px;
}
.am-batch-count {
  font-weight: 600;
  color: var(--bbi-accent);
  white-space: nowrap;
}
.am-batch-spacer {
  flex: 1 1 auto;
}

.am-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

.am-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(158px, 1fr));
  gap: 10px;
  padding: 2px 2px 6px;
}

.am-empty {
  margin: 0;
  padding: 56px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--bbi-ink-soft);
}

/* —— 卡片:点主体 = 启用/停用;选中态用浅底区分(与启用态的描边是两回事) —— */
.am-card {
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
.am-card:hover {
  border-color: var(--bbi-accent);
}
.am-card.is-active {
  border-color: var(--bbi-accent);
  box-shadow: 0 0 0 1px var(--bbi-accent);
}
.am-card.is-selected {
  background: var(--bbi-accent-soft);
}

/* 预览图区:固定 4:3,占位与实图同几何,卡片高度才齐 */
.am-art {
  position: relative;
  aspect-ratio: 4 / 3;
  background: var(--bbi-surface-2);
}
.am-art-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.am-art-empty {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 0;
  background: transparent;
  color: var(--bbi-ink-muted);
  font-family: var(--bbi-font-sans);
  font-size: 11px;
  cursor: pointer;
}
.am-art-empty:hover {
  color: var(--bbi-accent);
}
.am-art-empty:disabled {
  cursor: default;
  opacity: 0.6;
}
.am-art-empty--static,
.am-art-empty--static:hover {
  cursor: default;
  color: var(--bbi-ink-muted);
}

/* 勾选框垫一片 surface 底,压在图上也可辨认 */
.am-check {
  position: absolute;
  top: 6px;
  left: 6px;
  display: flex;
  padding: 2px;
  border-radius: 6px;
  background: var(--bbi-surface);
  border: 1px solid var(--bbi-line-strong);
  cursor: pointer;
}
.am-check .bbi-checkbox {
  width: 15px;
  height: 15px;
}

.am-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 8px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface);
  color: var(--bbi-ink-muted);
  border: 1px solid var(--bbi-line);
}
.am-badge.is-on {
  background: var(--bbi-accent);
  color: var(--bbi-accent-ink);
  border-color: transparent;
}

/* 「更换预览图」:hover 才浮现的居中胶囊,平时不挡图;
   触屏没有 hover,走编辑弹窗里的同款按钮(双通道,不藏死) */
.am-art-change {
  position: absolute;
  left: 50%;
  bottom: 8px;
  transform: translateX(-50%);
  padding: 4px 10px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface);
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--bbi-dur) var(--bbi-ease);
}
.am-card:hover .am-art-change,
.am-art-change:focus-visible,
.am-art-change:disabled {
  opacity: 1;
}
.am-art-change:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}

.am-body {
  padding: 8px 10px 9px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.am-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
/* 单选圈:与勾选框(方形、批量)形态区分开,传达「启用是互斥单选」 */
.am-radio {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border: 1.5px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-pill);
  color: var(--bbi-accent-ink);
}
.am-radio.is-on {
  background: var(--bbi-accent);
  border-color: var(--bbi-accent);
}
.am-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 内容摘要:等宽两行截断,min-height 撑齐没填内容的卡 */
.am-prompt {
  font-family: var(--bbi-font-mono);
  font-size: 11px;
  line-height: 1.5;
  color: var(--bbi-ink-muted);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
  min-height: 2.9em;
}

.am-ops {
  display: flex;
  gap: 4px;
  margin-top: 2px;
}
.am-op {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface);
  color: var(--bbi-ink-soft);
  cursor: pointer;
}
.am-op:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}
/* 删除推到行尾,与编辑/复制两个「建设性」操作拉开距离 */
.am-op-danger {
  margin-left: auto;
}
.am-op-danger:hover {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}

.am-foot {
  align-items: center;
}
.am-foot-hint {
  font-size: 12px;
  color: var(--bbi-ink-muted);
}
.bbi-modal-foot-spacer {
  flex: 1 1 auto;
}

/* —— 编辑/查看弹窗 —— */
.am-edit {
  max-width: 560px;
}
.am-edit-preview {
  display: flex;
  align-items: center;
  gap: 12px;
}
.am-edit-thumb {
  width: 112px;
  height: 84px;
  object-fit: cover;
  border-radius: var(--bbi-radius-sm);
  border: 1px solid var(--bbi-line);
  background: var(--bbi-surface-2);
}
.am-edit-thumb--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--bbi-ink-muted);
  font-size: 20px;
}
.am-edit-preview-ops {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

/* 危险按钮:与设置页/ConfirmDialog 同一口径,scoped 不跨组件故补一份 */
.am-btn-danger {
  color: var(--bbi-danger);
  border-color: var(--bbi-line-strong);
}
.am-btn-danger:hover {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}

/* 组头/弹窗里的小图标钮:与 NaiPanel 同款,scoped 不跨组件故补一份 */
.bbi-icon-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface);
  color: var(--bbi-ink-soft);
  cursor: pointer;
  font-size: 12px;
}
.bbi-icon-mini:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}

@media (max-width: 640px) {
  .am-modal {
    max-width: 100%;
  }
  .am-grid {
    grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  }
  .am-foot-hint {
    display: none;
  }
}
</style>
