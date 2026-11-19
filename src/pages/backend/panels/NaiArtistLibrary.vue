<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  applyArtistVibeState,
  applyNaiPresetParams,
  matchArtist,
  planArtistRemoval,
  snapshotNaiPresetParams,
} from '@/backends/naiArtistLib';
import { buildPresetExportFile, importPresetFile } from '@/backends/naiPresetFile';
import { BUILTIN_NAI_ARTISTS, generateNaiImage, naiRandomSeed } from '@/backends/nai';
import { acquireNaiSlot } from '@/floor/genQueue';
import BbiTextarea from '@/components/BbiTextarea.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import ArtistTile from '@/pages/backend/panels/ArtistTile.vue';
import { artistPreviewSrc, bumpArtistPreview, bumpArtistPreviews } from '@/pages/backend/panels/artistPreview';
import { makeJpegThumbnail, readFileAsDataUrl } from '@/st/imageFile';
import { ARTIST_PREVIEW_FOLDER, deleteUserImage, uploadUserImage } from '@/st/images';
import { newNaiArtist, activeNaiPlan, effectiveNai, settings, type NaiArtistPreset } from '@/state/settings';

/**
 * 画师串库(NAI 面板「画师串库」折叠区里就地展开,不再隔一层「管理」窗口)。
 *
 * 只管**库**:新建、搜索、改名改内容、预览图、复制、删除、Vibe 绑定、参数快照。
 * 选哪条生效仍由面板下拉与楼层快捷浮层负责(阶段 5 的方案库会再加一个 Picker)。
 *
 * 库可能有几十上百条(智绘姬整批导入):卡片网格框定高度自己滚,条目多时才出搜索框;
 * 批量删除收在「多选」模式里,平时不出勾选框。
 *
 * 内置条(bi_*)随插件版本更新,只读:能看、能复制,不能改删。
 * 预览图上传后压成最长边 512 的 jpeg,落 user/images/柏宝绘_画师串/<条目id>.jpg,
 * 路径记在条目 previewPath 上;换图同名覆盖,删条目时连带删文件。
 */

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface LibItem {
  preset: NaiArtistPreset;
  builtin: boolean;
}

/** 条目超过这么多才出搜索框:三五条时一个搜索框只是多一行杂物。 */
const SEARCH_THRESHOLD = 6;

const search = ref('');

const items = computed<LibItem[]>(() => [
  ...BUILTIN_NAI_ARTISTS.map(p => ({ preset: p, builtin: true })),
  ...settings.nai.artistPresets.map(p => ({ preset: p, builtin: false })),
]);

const filtered = computed(() => items.value.filter(i => matchArtist(i.preset, search.value)));

const activeId = computed(() => activeNaiPlan().artistId);

/* ============ 多选(只服务于批量删除) ============ */

const multi = ref(false);
/** 勾选集只存用户条目 id;内置条在多选态下点不动,天然进不来。 */
const selected = ref<ReadonlySet<string>>(new Set());

const selectableFiltered = computed(() => filtered.value.filter(i => !i.builtin));
const allFilteredSelected = computed(
  () =>
    selectableFiltered.value.length > 0 &&
    selectableFiltered.value.every(i => selected.value.has(i.preset.id)),
);

function toggleMulti() {
  multi.value = !multi.value;
  selected.value = new Set();
}

function toggleSelect(id: string) {
  const next = new Set(selected.value);
  if (!next.delete(id)) next.add(id);
  selected.value = next;
}

function toggleSelectAllFiltered() {
  const next = new Set(selected.value);
  for (const i of selectableFiltered.value) {
    if (allFilteredSelected.value) next.delete(i.preset.id);
    else next.add(i.preset.id);
  }
  selected.value = next;
}

/* ============ 启用/停用(与面板下拉、楼层浮层同一口径) ============ */

function useItem(item: LibItem) {
  const id = item.preset.id;
  const plan = activeNaiPlan();
  if (activeId.value === id) {
    plan.artistId = '';
    settings.nai.activeArtistId = '';
    toastr.success('已停用画师串', '画师串');
    return;
  }
  plan.artistId = id;
  settings.nai.activeArtistId = id;
  applyArtistVibeState(settings.nai.vibes, item.preset);
  toastr.success(`已切换到「${item.preset.name || '未命名画师串'}」`, '画师串');
}

function onTileClick(item: LibItem) {
  if (multi.value) {
    if (!item.builtin) toggleSelect(item.preset.id);
    return;
  }
  openEdit(item);
}

/* ============ 编辑弹窗(名字/画师串/正负面词走草稿,预览图即时落盘) ============ */

const editItem = ref<LibItem | null>(null);
const editName = ref('');
const editPrompt = ref('');
const editQuality = ref('');
const editNegative = ref('');
/** 刚点「新建」建出来的:取消 = 连条目一起撤掉,不在库里留一条空的「画师串 N」。 */
const editIsNew = ref(false);

function openEdit(item: LibItem, isNew = false) {
  editItem.value = item;
  editName.value = item.preset.name;
  editPrompt.value = item.preset.prompt;
  editQuality.value = item.preset.quality;
  editNegative.value = item.preset.negative;
  editIsNew.value = isNew;
}

/**
 * 新建先入库再开编辑:预览图要拿条目 id 当文件名,草稿态没处落盘。
 * 取消时由 cancelEdit 撤回(连同可能已上传的预览图)。
 */
function addArtist() {
  const preset = newNaiArtist(`画师串 ${settings.nai.artistPresets.length + 1}`);
  settings.nai.artistPresets.push(preset);
  openEdit({ preset, builtin: false }, true);
}

function cancelEdit() {
  const item = editItem.value;
  editItem.value = null;
  if (item && editIsNew.value) void removeArtists([item.preset], { quiet: true });
}

function saveEdit() {
  const item = editItem.value;
  if (!item || item.builtin) return; // 内置只读(按钮已隐藏,双保险)
  item.preset.name = editName.value.trim();
  item.preset.prompt = editPrompt.value;
  item.preset.quality = editQuality.value;
  item.preset.negative = editNegative.value;
  editItem.value = null;
}

/**
 * 复制 = 按弹窗里**眼下看到的**名字与内容另存一条,原条目不动(未保存的改动不会写回原条目)。
 * 预览图不随副本走:预览文件随原条目删除,共指一个路径会让副本日后破图。
 * 副本插在原条目后面(内置的副本插在用户库最前):库长了,追加到末尾就得滚到底去找。
 */
function duplicateFromEdit() {
  const item = editItem.value;
  if (!item) return;
  const name = editName.value.trim() || '未命名画师串';
  const copy: NaiArtistPreset = {
    id: newNaiArtist().id,
    name: `${name} 副本`,
    prompt: editPrompt.value,
    quality: editQuality.value,
    negative: editNegative.value,
    vibes: item.preset.vibes?.map(ref => ({ ...ref })),
    params: item.preset.params ? { ...item.preset.params } : undefined,
  };
  const list = settings.nai.artistPresets;
  const index = list.findIndex(p => p.id === item.preset.id);
  list.splice(index + 1, 0, copy);
  openEdit({ preset: copy, builtin: false });
  toastr.success(`已复制为「${copy.name}」`, '画师串');
}

/** 复制卡片(不开编辑窗):同样不带走预览图。 */
function duplicateItem(item: LibItem) {
  const src = item.preset;
  const copy: NaiArtistPreset = {
    id: newNaiArtist().id,
    name: `${src.name} 副本`,
    prompt: src.prompt,
    quality: src.quality,
    negative: src.negative,
    vibes: src.vibes?.map(ref => ({ ...ref })),
    params: src.params ? { ...src.params } : undefined,
  };
  settings.nai.artistPresets.push(copy);
  toastr.success(`已复制为「${copy.name}」`, '画师串');
}

/* ============ Vibe 绑定与参数快照(本地能力,上游方案化后删了,这里保留) ============ */

/** 把当前 Vibe 库的启用状态与强度快照到这条画师串上。 */
function saveArtistVibeState(preset: NaiArtistPreset) {
  preset.vibes = settings.nai.vibes.map(vibe => ({
    id: vibe.id,
    enabled: vibe.enabled,
    strength: vibe.strength,
  }));
  toastr.success(`已保存 ${preset.vibes.length} 条 Vibe 状态到「${preset.name}」`, '画师串');
}

function unbindArtistVibes(preset: NaiArtistPreset) {
  delete preset.vibes;
  toastr.success(`已解除「${preset.name}」的 Vibe 绑定`, '画师串');
}

/** 把当前渠道参数快照进这条画师串(导出与「应用参数」共用同一形状)。 */
function savePresetParams(preset: NaiArtistPreset) {
  preset.params = snapshotNaiPresetParams(settings.nai);
  toastr.success(`已保存当前参数到「${preset.name}」`, '画师串');
}

/** 显式应用预设携带的模型参数;切换画师串本身不会静默改模型。 */
function applyParams(preset: NaiArtistPreset) {
  if (!preset.params) return;
  applyNaiPresetParams(settings.nai, preset.params);
  toastr.success(`已应用「${preset.name}」的模型参数`, '画师串');
}

/* ============ 预览图 ============ */

/** 预览图最长边:挑选弹窗的卡片约 140px 宽,512 留足高分屏余量,又不把 user/images 撑大。 */
const PREVIEW_MAX_EDGE = 512;

const previewFileInput = ref<HTMLInputElement | null>(null);
/** 本次上传要为哪条换图;文件框是共享的一个,靠它在 change 时找回目标。 */
let previewTarget: NaiArtistPreset | null = null;
const uploadingId = ref<string | null>(null);

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
    bumpArtistPreview(target.id);
  } catch (error) {
    toastr.error(errorMessage(error), '预览图上传失败');
  } finally {
    uploadingId.value = null;
  }
}

/** 生成预览图:用当前方案的模型/参数 + 这条画师串真实出一张。 */
const generatingId = ref<string | null>(null);
const generateAbort = ref<AbortController | null>(null);

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

async function generatePreview(preset: NaiArtistPreset): Promise<void> {
  if (generatingId.value) return;
  const conn = settings.nai;
  if (!conn.key.trim()) {
    toastr.error('请先填写 NAI API Key', '画师串');
    return;
  }
  const plan = activeNaiPlan(conn);
  const prompt = plan.previewPrompt.trim();
  if (!prompt) {
    toastr.error('当前方案没有示例提示词，请先在方案里填', '画师串');
    return;
  }
  generatingId.value = preset.id;
  const controller = new AbortController();
  generateAbort.value = controller;
  let release: (() => void) | null = null;
  let resultUrl = '';
  try {
    const run = effectiveNai(conn, { ...plan, artistId: preset.id });
    release = await acquireNaiSlot(controller.signal, run.endpointId);
    const output = await generateNaiImage(
      run,
      {
        prompt,
        nl: '',
        characters: [],
        seed: plan.seed > 0 ? plan.seed : naiRandomSeed(),
        size: plan.orientationLock === 'auto' ? 'portrait' : plan.orientationLock,
      },
      controller.signal,
    );
    resultUrl = output.result.url;
    const jpeg = await previewBase64(resultUrl);
    preset.previewPath = await uploadUserImage(
      ARTIST_PREVIEW_FOLDER,
      preset.id,
      jpeg.split(',')[1] ?? '',
      'jpg',
    );
    bumpArtistPreview(preset.id);
    toastr.success(`「${preset.name}」预览图已更新`, '画师串');
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      toastr.info('已取消生成预览图', '画师串');
    } else {
      toastr.error(errorMessage(error), '生成预览图失败');
    }
  } finally {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    generatingId.value = null;
    generateAbort.value = null;
    release?.();
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

/* ============ 删除(编辑弹窗里的单条与多选批量共用确认框) ============ */

const deleteOpen = ref(false);
const deleteList = ref<NaiArtistPreset[]>([]);
const deleting = ref(false);

/** 被删条目里是否有当前使用中的那条:确认框里点名,删后回「不使用画师串」。 */
const deleteAffectsActive = computed(() =>
  deleteList.value.some(p => p.id === settings.nai.activeArtistId),
);

function askDelete(presets: NaiArtistPreset[]) {
  if (!presets.length) return;
  deleteList.value = presets;
  deleteOpen.value = true;
}

function askDeleteSelected() {
  const byId = new Map(settings.nai.artistPresets.map(p => [p.id, p]));
  askDelete([...selected.value].map(id => byId.get(id)).filter((p): p is NaiArtistPreset => !!p));
}

/** 删条目 + 清预览文件 + 当前项接位(不静默换画风,见 planArtistRemoval)。 */
async function removeArtists(
  presets: NaiArtistPreset[],
  options: { quiet?: boolean } = {},
): Promise<{ removed: number; fileFailures: number }> {
  const ids = new Set(presets.map(p => p.id));
  const plan = activeNaiPlan();
  const removal = planArtistRemoval(settings.nai.artistPresets, ids, plan.artistId);
  // 预览文件清理 best-effort:文件没删掉不阻塞删条目(孤儿文件可手动清,条目删不掉才烦人)
  let fileFailures = 0;
  for (const p of removal.removed) {
    if (!p.previewPath) continue;
    try {
      await deleteUserImage(p.previewPath);
    } catch {
      fileFailures += 1;
    }
  }
  // 按 id 现过滤而非直接用 plan.remaining:上面等删文件期间库可能又被改过(新建/复制)
  settings.nai.artistPresets = settings.nai.artistPresets.filter(a => !ids.has(a.id));
  plan.artistId = removal.nextActiveId;
  settings.nai.activeArtistId = removal.nextActiveId;
  const nextSelected = new Set(selected.value);
  for (const id of ids) nextSelected.delete(id);
  selected.value = nextSelected;
  if (!options.quiet) {
    if (fileFailures) {
      toastr.warning(`已删除 ${removal.removed.length} 条,但 ${fileFailures} 张预览图文件清理失败`, '画师串');
    } else {
      toastr.success(`已删除 ${removal.removed.length} 条画师串`, '画师串');
    }
  }
  return { removed: removal.removed.length, fileFailures };
}

async function confirmDelete() {
  if (deleting.value) return;
  deleting.value = true;
  const list = deleteList.value;
  deleteOpen.value = false;
  const { removed, fileFailures } = await removeArtists(list);
  deleting.value = false;
  // 删的是正在编辑的那条 → 编辑窗没了对象,一并关掉
  if (editItem.value && !settings.nai.artistPresets.includes(editItem.value.preset) && !editItem.value.builtin) {
    editItem.value = null;
  }
  if (multi.value && !settings.nai.artistPresets.length) multi.value = false;
  if (fileFailures) {
    toastr.warning(`已删除 ${removed} 条,但 ${fileFailures} 张预览图文件清理失败`, '画师串');
  }
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
  const presets = settings.nai.artistPresets;
  if (!presets.length) {
    toastr.warning('还没有画师串可导出', '画师串');
    return;
  }
  exporting.value = true;
  try {
    const result = await buildPresetExportFile({
      presets,
      vibes: settings.nai.vibes,
      fallbackParams: snapshotNaiPresetParams(settings.nai),
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
      existingPresets: settings.nai.artistPresets,
      existingVibes: settings.nai.vibes,
      model: settings.nai.model,
    });
    settings.nai.artistPresets = result.presets;
    settings.nai.vibes = result.vibes;
    bumpArtistPreviews(result.presets);
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
</script>

<template>
  <div class="al">
    <input
      v-if="items.length > SEARCH_THRESHOLD"
      v-model="search"
      class="bbi-input al-search"
      type="search"
      placeholder="搜索名称或画师串内容…"
      spellcheck="false"
      aria-label="搜索画师串"
    />

    <div class="al-scroll">
      <p v-if="!filtered.length" class="al-empty">没有匹配「{{ search }}」的画师串。</p>
      <div v-else class="al-grid">
        <ArtistTile
          v-for="item in filtered"
          :key="item.preset.id"
          :preset="item.preset"
          :builtin="item.builtin"
          :active="item.preset.id === activeId"
          :checked="multi && !item.builtin ? selected.has(item.preset.id) : undefined"
          :disabled="multi && item.builtin"
          @click="onTileClick(item)"
          @toggle-select="toggleSelect(item.preset.id)"
          @use="useItem(item)"
          @edit="openEdit(item)"
          @duplicate="duplicateItem(item)"
          @delete="askDelete([item.preset])"
        />
      </div>
    </div>

    <div class="list-foot">
      <template v-if="!multi">
        <button class="bbi-btn bbi-btn-sm" type="button" @click="addArtist">
          <Icon name="plus" :size="12" />
          新建画师串
        </button>
        <button class="bbi-btn bbi-btn-sm" type="button" :disabled="exporting" @click="exportPresets">
          <Icon name="download" :size="12" /> {{ exporting ? '导出中…' : '导出' }}
        </button>
        <button class="bbi-btn bbi-btn-sm" type="button" :disabled="importing" @click="pickImportFile">
          <Icon name="upload" :size="12" /> {{ importing ? '导入中…' : '导入' }}
        </button>
        <span class="list-foot-spacer"></span>
        <button
          v-if="settings.nai.artistPresets.length"
          class="quiet-btn"
          type="button"
          title="勾选多条一起删除"
          @click="toggleMulti"
        >
          <Icon name="checklist" :size="13" />
          多选
        </button>
      </template>
      <template v-else>
        <span class="al-count">已选 {{ selected.size }} 条</span>
        <button class="quiet-btn" type="button" :disabled="!selectableFiltered.length" @click="toggleSelectAllFiltered">
          {{ allFilteredSelected ? '取消全选' : '全选' }}
        </button>
        <span class="list-foot-spacer"></span>
        <button
          class="bbi-btn bbi-btn-sm bbi-btn-danger"
          type="button"
          :disabled="!selected.size"
          @click="askDeleteSelected"
        >
          <Icon name="trash" :size="12" />
          删除所选
        </button>
        <button class="bbi-btn bbi-btn-sm" type="button" @click="toggleMulti">完成</button>
      </template>
    </div>

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
  </div>

  <!-- 编辑/查看:名称 + 画师串 + 正/负面词 + Vibe 绑定 + 参数快照 + 预览图 -->
  <ModalMask :open="!!editItem" @close="cancelEdit">
    <div
      v-if="editItem"
      class="bbi-modal al-edit"
      role="dialog"
      aria-modal="true"
      :aria-label="editItem.builtin ? '查看画师串' : '编辑画师串'"
    >
      <header class="bbi-modal-head">
        <span class="bbi-modal-title">
          {{ editItem.builtin ? '查看画师串(内置)' : editIsNew ? '新建画师串' : '编辑画师串' }}
        </span>
        <button class="bbi-icon-mini" type="button" title="关闭" aria-label="关闭" @click="cancelEdit">
          <Icon name="close" />
        </button>
      </header>

      <div v-if="!editItem.builtin || editItem.preset.previewPath" class="al-preview">
        <img
          v-if="editItem.preset.previewPath"
          class="al-thumb"
          :src="artistPreviewSrc(editItem.preset)"
          :alt="editItem.preset.name"
        />
        <button
          v-else
          class="al-thumb al-thumb--empty"
          type="button"
          :disabled="uploadingId === editItem.preset.id"
          title="上传预览图"
          @click="pickPreview(editItem.preset)"
        >
          <Icon name="upload" :size="18" />
        </button>
        <div v-if="!editItem.builtin" class="al-preview-ops">
          <span class="bbi-modal-label">预览图</span>
          <span class="al-preview-btns">
            <button
              class="bbi-btn bbi-btn-sm"
              type="button"
              :disabled="uploadingId === editItem.preset.id || generatingId === editItem.preset.id"
              title="用当前方案的模型/参数 + 这条画师串出一张"
              @click="generatePreview(editItem.preset)"
            >
              <Icon name="generate" :size="12" />
              {{ generatingId === editItem.preset.id ? '生成中…' : '生成预览图' }}
            </button>
            <button
              v-if="generatingId === editItem.preset.id"
              class="bbi-btn bbi-btn-sm"
              type="button"
              @click="generateAbort?.abort()"
            >
              取消
            </button>
            <button
              class="bbi-btn bbi-btn-sm"
              type="button"
              :disabled="uploadingId === editItem.preset.id"
              @click="pickPreview(editItem.preset)"
            >
              {{ uploadingId === editItem.preset.id ? '上传中…' : editItem.preset.previewPath ? '更换' : '上传' }}
            </button>
            <button
              v-if="editItem.preset.previewPath"
              class="bbi-btn bbi-btn-sm bbi-btn-danger"
              type="button"
              @click="removePreview(editItem.preset)"
            >
              移除
            </button>
          </span>
        </div>
      </div>

      <label class="bbi-modal-field">
        <span class="bbi-modal-label">名称</span>
        <input
          v-model="editName"
          class="bbi-input"
          type="text"
          :readonly="editItem.builtin"
          placeholder="画师串名称"
          spellcheck="false"
        />
      </label>

      <label class="bbi-modal-field">
        <span class="bbi-modal-label">画师串(拼在正向提示词最前面)</span>
        <BbiTextarea
          v-model="editPrompt"
          :rows="4"
          :max-rows="12"
          mono
          :readonly="editItem.builtin"
          placeholder="artist:xxx, artist:yyy"
        />
      </label>

      <label class="bbi-modal-field">
        <span class="bbi-modal-label">正面质量词(留空 = 跟随渠道级/模型官方词)</span>
        <BbiTextarea
          v-model="editQuality"
          :rows="2"
          :max-rows="6"
          mono
          :readonly="editItem.builtin"
          placeholder="very aesthetic, masterpiece, no text"
        />
      </label>

      <label class="bbi-modal-field">
        <span class="bbi-modal-label">负面提示词(留空 = 跟随渠道级/模型官方词)</span>
        <BbiTextarea
          v-model="editNegative"
          :rows="2"
          :max-rows="6"
          mono
          :readonly="editItem.builtin"
          placeholder="lowres, worst quality, bad anatomy"
        />
      </label>

      <div v-if="!editItem.builtin" class="al-extra">
        <div class="al-extra-head">
          <span class="bbi-modal-label">Vibe 绑定</span>
          <span class="al-extra-state">
            {{ editItem.preset.vibes === undefined
              ? '未绑定(切换时不动 Vibe)'
              : editItem.preset.vibes.length
                ? `已绑定 ${editItem.preset.vibes.length} 条`
                : '明确不使用 Vibe' }}
          </span>
        </div>
        <div class="al-extra-ops">
          <button class="bbi-btn bbi-btn-sm" type="button" @click="saveArtistVibeState(editItem.preset)">
            保存当前 Vibe 状态
          </button>
          <button
            v-if="editItem.preset.vibes"
            class="bbi-btn bbi-btn-sm"
            type="button"
            @click="unbindArtistVibes(editItem.preset)"
          >
            解除绑定
          </button>
        </div>
      </div>

      <div v-if="!editItem.builtin" class="al-extra">
        <div class="al-extra-head">
          <span class="bbi-modal-label">参数快照</span>
          <span class="al-extra-state">
            {{ editItem.preset.params
              ? `${editItem.preset.params.model} · ${editItem.preset.params.sampler} · ${editItem.preset.params.steps} 步`
              : '未保存' }}
          </span>
        </div>
        <div class="al-extra-ops">
          <button class="bbi-btn bbi-btn-sm" type="button" @click="savePresetParams(editItem.preset)">
            保存当前参数
          </button>
          <button
            v-if="editItem.preset.params"
            class="bbi-btn bbi-btn-sm"
            type="button"
            title="把快照里的模型与采样参数应用到当前渠道"
            @click="applyParams(editItem.preset)"
          >
            应用参数
          </button>
        </div>
      </div>

      <footer class="bbi-modal-foot">
        <button
          v-if="!editItem.builtin"
          class="bbi-btn"
          type="button"
          @click="useItem(editItem)"
        >
          {{ editItem.preset.id === activeId ? '停用这条' : '设为当前画师串' }}
        </button>
        <template v-if="editItem.builtin">
          <button class="bbi-btn" type="button" @click="duplicateFromEdit">
            <Icon name="copy" /> 复制为我的画师串
          </button>
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="cancelEdit">关闭</button>
        </template>
        <template v-else>
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn" type="button" @click="cancelEdit">取消</button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="saveEdit">完成</button>
        </template>
      </footer>
    </div>
  </ModalMask>

  <!-- 删除确认:单条与批量共用 -->
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
      确定删除画师串「{{ deleteList[0]?.name || '未命名画师串' }}」？删除后无法恢复。
    </template>
    <template v-else>
      确定删除选中的 {{ deleteList.length }} 条画师串？删除后无法恢复。
    </template>
    <template v-if="deleteAffectsActive">
      <br />当前正在使用其中一条,删除后会回「不使用画师串」。
    </template>
  </ConfirmDialog>
</template>

<style scoped>
.al {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.al-search {
  padding: 6px 10px;
}

.al-scroll {
  max-height: 340px;
  overflow-y: auto;
  padding: 2px;
}

.al-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
}

.al-empty {
  margin: 0;
  padding: 32px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--bbi-ink-soft);
}

.al-count {
  font-size: 12px;
  color: var(--bbi-ink-muted);
  white-space: nowrap;
}

.al-preview {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.al-thumb {
  width: 132px;
  aspect-ratio: 4 / 3;
  object-fit: cover;
  border-radius: var(--bbi-radius);
  border: 1px solid var(--bbi-line);
  background: var(--bbi-surface-2);
}

.al-thumb--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--bbi-ink-soft);
  cursor: pointer;
}

.al-preview-ops {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.al-preview-btns {
  display: flex;
  gap: 6px;
}

.al-extra {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
}

.al-extra-head {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: space-between;
}

.al-extra-state {
  font-size: 11px;
  color: var(--bbi-ink-soft);
}

.al-extra-ops {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
</style>
