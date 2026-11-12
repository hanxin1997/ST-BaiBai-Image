import { naiDefaultUndesired } from '@/backends/nai';
import {
  clampVibeStrength,
  DEFAULT_VIBE_STRENGTH,
  loadVibeData,
  saveVibeFiles,
  vibeFingerprint,
  vibeMetaFromData,
} from '@/backends/vibeStore';
import { makeJpegThumbnail } from '@/st/imageFile';
import { ARTIST_PREVIEW_FOLDER, deleteUserImage, uploadUserImage } from '@/st/images';
import {
  newNaiArtist,
  normalizePresetParams,
  type NaiArtistPreset,
  type NaiArtistVibeRef,
  type NaiPresetParams,
  type NaiVibe,
  type NaiVibeData,
  type NaiVibeEncodings,
} from '@/state/settings';

/**
 * 画师串预设文件的导出/导入(与智绘姬 st-chatu8、LittleWhiteBox 互通)。
 *
 * 文件形态沿用智绘姬:
 *   { presets: { 名称: { fixedPrompt, fixedPrompt_end, negativePrompt, previewImageId?, vibe?, params? } },
 *     images:  { id: dataURL },
 *     vibes?:  { singles: [...], groups: [...] } }
 *
 * 智绘姬不认识 vibe / params / source / version,导入时原样存下但不使用;
 * LWB 认识 vibe / vibes。额外字段对互通无副作用,却能让本插件自己的文件带全
 * Vibe 与模型参数。图片只存一份(dataURL),缩略图不内嵌,避免体积翻倍。
 */

const EXPORT_SOURCE = 'baibai-image';
const EXPORT_VERSION = 1;
const IMAGE_ID_PREFIX = 'bbi-thumb-';
const GROUP_ID_PREFIX = 'bbi-group-';
const PREVIEW_MAX_EDGE = 512;
const PREVIEW_QUALITY = 0.85;
const FETCH_TIMEOUT_MS = 20_000;

export interface PresetExportOptions {
  presets: readonly NaiArtistPreset[];
  vibes: readonly NaiVibe[];
  /** 没有参数快照的旧预设用它兜底(通常是当前渠道参数)。 */
  fallbackParams: NaiPresetParams;
}

export interface PresetExportResult {
  json: string;
  counts: { presets: number; vibes: number; previews: number };
  warnings: string[];
}

interface ExportedVibe {
  single: {
    id: string;
    name: string;
    image: string;
    thumbnail: string;
    infoExtracted: number;
    encodings: Record<string, string>;
  };
  groupName: string;
  strength: number;
  enabled: boolean;
}

interface ExportedVibeGroup {
  id: string;
  name: string;
  members: NaiArtistVibeRef[];
}

/** 导出全部画师串;Vibe 只带被预设引用到的,未引用的大库不会拖大文件。 */
export async function buildPresetExportFile(
  options: PresetExportOptions,
): Promise<PresetExportResult> {
  const warnings: string[] = [];
  const exportedVibes = await loadExportableVibes(
    options.vibes,
    collectNeededVibeIds(options.presets),
    warnings,
  );
  const groups = buildExportGroups(exportedVibes);
  const images: Record<string, string> = {};
  const presets: Record<string, unknown> = {};
  const usedNames = new Set<string>();
  for (const [index, preset] of options.presets.entries()) {
    const name = uniqueName(preset.name, index, usedNames);
    if (name !== preset.name) warnings.push(`「${preset.name}」重名,导出为「${name}」`);
    presets[name] = await exportPreset(
      preset,
      index,
      options.fallbackParams,
      exportedVibes,
      groups,
      images,
      warnings,
    );
  }

  const file: Record<string, unknown> = { source: EXPORT_SOURCE, version: EXPORT_VERSION, presets };
  if (Object.keys(images).length) file.images = images;
  const singles = [...exportedVibes.values()].map(item => item.single);
  if (singles.length) file.vibes = { singles, groups: [...groups.values()] };
  return {
    json: JSON.stringify(file, null, 2),
    counts: { presets: options.presets.length, vibes: singles.length, previews: Object.keys(images).length },
    warnings,
  };
}

function collectNeededVibeIds(presets: readonly NaiArtistPreset[]): Set<string> {
  const ids = new Set<string>();
  for (const preset of presets) {
    for (const ref of preset.vibes ?? []) ids.add(ref.id);
  }
  return ids;
}

async function loadExportableVibes(
  vibes: readonly NaiVibe[],
  neededIds: ReadonlySet<string>,
  warnings: string[],
): Promise<Map<string, ExportedVibe>> {
  const byId = new Map(vibes.map(vibe => [vibe.id, vibe]));
  const out = new Map<string, ExportedVibe>();
  for (const id of neededIds) {
    const vibe = byId.get(id);
    if (!vibe) continue;
    try {
      const data = await loadVibeData(vibe);
      out.set(id, {
        single: exportVibeSingle(vibe, data),
        groupName: vibe.group.trim(),
        strength: vibe.strength,
        enabled: vibe.enabled,
      });
    } catch {
      warnings.push(`Vibe「${vibe.name}」数据读取失败,已从导出中省略`);
    }
  }
  return out;
}

function exportVibeSingle(vibe: NaiVibe, data: NaiVibeData): ExportedVibe['single'] {
  const encodings: Record<string, string> = {};
  for (const [key, enc] of Object.entries(data.encodings)) encodings[key] = enc.encoding;
  const first = Object.values(data.encodings)[0];
  return {
    id: vibe.id,
    name: vibe.name,
    image: data.image,
    thumbnail: data.thumbnail,
    infoExtracted: first?.infoExtracted ?? 1,
    encodings,
  };
}

function buildExportGroups(exported: ReadonlyMap<string, ExportedVibe>): Map<string, ExportedVibeGroup> {
  const groups = new Map<string, ExportedVibeGroup>();
  let seq = 0;
  for (const [id, item] of exported) {
    if (!item.groupName) continue;
    let group = groups.get(item.groupName);
    if (!group) {
      seq += 1;
      group = { id: `${GROUP_ID_PREFIX}${seq}`, name: item.groupName, members: [] };
      groups.set(item.groupName, group);
    }
    group.members.push({ id, enabled: item.enabled, strength: item.strength });
  }
  return groups;
}

function uniqueName(raw: string, index: number, used: Set<string>): string {
  const base = raw.trim() || `画师串 ${index + 1}`;
  let name = base;
  for (let seq = 2; used.has(name); seq++) name = `${base} (${seq})`;
  used.add(name);
  return name;
}

async function exportPreset(
  preset: NaiArtistPreset,
  index: number,
  fallbackParams: NaiPresetParams,
  exported: ReadonlyMap<string, ExportedVibe>,
  groups: ReadonlyMap<string, ExportedVibeGroup>,
  images: Record<string, string>,
  warnings: string[],
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {
    fixedPrompt: preset.prompt,
    fixedPrompt_end: preset.quality,
    negativePrompt: preset.negative,
    params: preset.params ?? fallbackParams,
  };
  if (preset.previewPath) {
    const imageId = `${IMAGE_ID_PREFIX}${index + 1}`;
    try {
      images[imageId] = await fetchAsDataUrl(preset.previewPath);
      out.previewImageId = imageId;
    } catch {
      warnings.push(`「${preset.name}」预览图读取失败,导出中已省略`);
    }
  }
  const vibe = exportPresetVibe(preset, exported, groups);
  if (vibe) out.vibe = vibe;
  return out;
}

function exportPresetVibe(
  preset: NaiArtistPreset,
  exported: ReadonlyMap<string, ExportedVibe>,
  groups: ReadonlyMap<string, ExportedVibeGroup>,
): { groupId: string; selections: NaiArtistVibeRef[] } | undefined {
  if (preset.vibes === undefined) return undefined;
  const selections = preset.vibes
    .filter(ref => exported.has(ref.id))
    .map(ref => ({ id: ref.id, enabled: ref.enabled, strength: ref.strength }));
  const groupName = sharedGroupName(preset.vibes, exported);
  return { groupId: groupName ? (groups.get(groupName)?.id ?? '') : '', selections };
}

/** 只有全部绑定项同属一个组时才写 groupId(我们的组是扁平的,混合绑定没有组语义)。 */
function sharedGroupName(
  refs: readonly NaiArtistVibeRef[],
  exported: ReadonlyMap<string, ExportedVibe>,
): string {
  let name = '';
  for (const ref of refs) {
    const group = exported.get(ref.id)?.groupName ?? '';
    if (!group || (name && group !== name)) return '';
    name = group;
  }
  return name;
}

async function fetchAsDataUrl(path: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(path, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('读取预览图失败'));
      reader.readAsDataURL(blob);
    });
  } finally {
    clearTimeout(timer);
  }
}

/* ============ 导入 ============ */

export interface PresetImportOptions {
  text: string;
  existingPresets: readonly NaiArtistPreset[];
  existingVibes: readonly NaiVibe[];
  /** 当前渠道模型;外来文件的自定义负向词会拼上它的官方基线(智绘姬同口径)。 */
  model: string;
}

export interface PresetImportResult {
  /** 合并后的完整画师串库(新建追加、同名原位覆盖)。 */
  presets: NaiArtistPreset[];
  /** 合并后的完整 Vibe 库(新建追加,内容重复的复用已有条目)。 */
  vibes: NaiVibe[];
  imported: number;
  overwritten: number;
  skipped: number;
  importedVibes: number;
  warnings: string[];
}

interface PresetFileData {
  presets: Record<string, Record<string, unknown>>;
  images: Record<string, string>;
  singles: unknown[];
  groups: unknown[];
  ours: boolean;
}

function parsePresetFile(text: string): PresetFileData {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('不是有效的 JSON 文件');
  }
  if (!raw || typeof raw !== 'object') throw new Error('文件内容不是预设对象');
  const root = raw as Record<string, unknown>;
  const presetsRaw = root.presets;
  if (!presetsRaw || typeof presetsRaw !== 'object') throw new Error('文件里没有 presets 字段');
  const presets: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(presetsRaw)) {
    if (value && typeof value === 'object') presets[name] = value as Record<string, unknown>;
  }
  if (!Object.keys(presets).length) throw new Error('文件里没有可导入的预设');
  const images: Record<string, string> = {};
  if (root.images && typeof root.images === 'object') {
    for (const [id, value] of Object.entries(root.images)) {
      if (typeof value === 'string' && value) images[id] = value;
    }
  }
  const vibes = root.vibes && typeof root.vibes === 'object' ? (root.vibes as Record<string, unknown>) : null;
  return {
    presets,
    images,
    singles: Array.isArray(vibes?.singles) ? vibes.singles : [],
    groups: Array.isArray(vibes?.groups) ? vibes.groups : [],
    ours: root.source === EXPORT_SOURCE,
  };
}

interface ImportedVibeState {
  created: NaiVibe[];
  /** 文件里的旧 id → 本库 id(含复用已有条目的映射)。 */
  idMap: Map<string, string>;
}

let vibeImportSeq = 0;

/** 导入 Vibe 单项与组:按内容指纹去重,组的成员关系落到我们的扁平 group 字段。 */
async function importVibes(
  file: PresetFileData,
  existing: readonly NaiVibe[],
  warnings: string[],
): Promise<ImportedVibeState> {
  const created: NaiVibe[] = [];
  const idMap = new Map<string, string>();
  const byFingerprint = new Map<string, string>();
  for (const vibe of existing) {
    if (vibe.fingerprint) byFingerprint.set(vibe.fingerprint, vibe.id);
  }

  for (const raw of file.singles) {
    if (!raw || typeof raw !== 'object') continue;
    const single = raw as Record<string, unknown>;
    const oldId = typeof single.id === 'string' ? single.id : '';
    if (!oldId) continue;
    const data = parseVibeData(single);
    if (!data) {
      warnings.push('文件里有一条 Vibe 缺少编码数据,已跳过');
      continue;
    }
    const fingerprint = vibeFingerprint(data.encodings);
    const known = byFingerprint.get(fingerprint);
    if (known) {
      idMap.set(oldId, known);
      continue;
    }
    const name = typeof single.name === 'string' && single.name.trim() ? single.name.trim() : '导入的 Vibe';
    vibeImportSeq += 1;
    const newId = `vibe_${Date.now()}_${vibeImportSeq}`;
    try {
      const paths = await saveVibeFiles(data, null, newId);
      created.push(
        vibeMetaFromData(
          newId,
          name,
          paths.dataPath,
          paths.thumbnailPath,
          data,
          DEFAULT_VIBE_STRENGTH,
          false,
        ),
      );
      idMap.set(oldId, newId);
      byFingerprint.set(fingerprint, newId);
    } catch (error) {
      warnings.push(`Vibe「${name}」保存失败:${errorMessage(error)}`);
    }
  }

  assignImportedGroups(file.groups, idMap, created);
  return { created, idMap };
}

function assignImportedGroups(
  groups: readonly unknown[],
  idMap: ReadonlyMap<string, string>,
  created: readonly NaiVibe[],
): void {
  const byId = new Map(created.map(vibe => [vibe.id, vibe]));
  for (const raw of groups) {
    if (!raw || typeof raw !== 'object') continue;
    const group = raw as { name?: unknown; members?: unknown };
    const name = typeof group.name === 'string' ? group.name.trim() : '';
    if (!name || !Array.isArray(group.members)) continue;
    for (const member of group.members) {
      const oldId = (member as { id?: unknown } | null)?.id;
      const newId = typeof oldId === 'string' ? idMap.get(oldId) : undefined;
      const target = newId ? byId.get(newId) : undefined;
      if (target && !target.group) target.group = name;
    }
  }
}

function parseVibeData(raw: Record<string, unknown>): NaiVibeData | null {
  if (!raw.encodings || typeof raw.encodings !== 'object') return null;
  const fallbackInfo = clampInfoExtracted(raw.infoExtracted);
  const encodings: NaiVibeEncodings = {};
  for (const [key, value] of Object.entries(raw.encodings as Record<string, unknown>)) {
    const enc = parseVibeEncoding(value, fallbackInfo);
    if (enc) encodings[key] = enc;
  }
  if (!Object.keys(encodings).length) return null;
  const image = typeof raw.image === 'string' ? raw.image : '';
  const thumbnail = typeof raw.thumbnail === 'string' && raw.thumbnail ? raw.thumbnail : image;
  return { image, thumbnail, encodings };
}

/** 兼容两种编码形态:LWB/智绘姬的字符串,以及官方 .naiv4vibe 的对象。 */
function parseVibeEncoding(
  value: unknown,
  fallbackInfo: number,
): { encoding: string; infoExtracted: number } | null {
  if (typeof value === 'string') {
    return value ? { encoding: value, infoExtracted: fallbackInfo } : null;
  }
  if (!value || typeof value !== 'object') return null;
  const o = value as { encoding?: unknown; infoExtracted?: unknown; params?: { information_extracted?: unknown } };
  if (typeof o.encoding !== 'string' || !o.encoding) return null;
  return {
    encoding: o.encoding,
    infoExtracted: clampInfoExtracted(o.infoExtracted ?? o.params?.information_extracted, fallbackInfo),
  };
}

function clampInfoExtracted(raw: unknown, fallback = 1): number {
  const value = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

export async function importPresetFile(options: PresetImportOptions): Promise<PresetImportResult> {
  const file = parsePresetFile(options.text);
  const warnings: string[] = [];
  const vibeState = await importVibes(file, options.existingVibes, warnings);
  const presets = [...options.existingPresets];
  const indexByName = new Map<string, number>();
  presets.forEach((preset, index) => {
    const name = preset.name.trim();
    if (name && !indexByName.has(name)) indexByName.set(name, index);
  });

  let imported = 0;
  let overwritten = 0;
  let skipped = 0;
  for (const [rawName, data] of Object.entries(file.presets)) {
    const name = rawName.trim();
    if (!name) {
      skipped += 1;
      continue;
    }
    const index = indexByName.get(name);
    const existing = index === undefined ? null : presets[index];
    const preset = await buildImportedPreset(name, data, existing, file, options.model, vibeState, warnings);
    if (index === undefined) {
      presets.push(preset);
      indexByName.set(name, presets.length - 1);
      imported += 1;
    } else {
      presets[index] = preset;
      overwritten += 1;
    }
  }
  return {
    presets,
    vibes: [...options.existingVibes, ...vibeState.created],
    imported,
    overwritten,
    skipped,
    importedVibes: vibeState.created.length,
    warnings,
  };
}

async function buildImportedPreset(
  name: string,
  data: Record<string, unknown>,
  existing: NaiArtistPreset | null,
  file: PresetFileData,
  model: string,
  vibeState: ImportedVibeState,
  warnings: string[],
): Promise<NaiArtistPreset> {
  const base = existing ?? newNaiArtist(name);
  const preset: NaiArtistPreset = {
    id: base.id,
    name,
    prompt: typeof data.fixedPrompt === 'string' ? data.fixedPrompt : '',
    quality: typeof data.fixedPrompt_end === 'string' ? data.fixedPrompt_end : '',
    negative: importNegative(data.negativePrompt, file.ours, model),
    previewPath: base.previewPath,
  };
  const vibes = parsePresetVibes(data.vibe, file.groups, vibeState.idMap);
  if (vibes) preset.vibes = vibes;
  const params = normalizePresetParams(data.params);
  if (params) preset.params = params;
  const previewDataUrl = resolvePreviewImage(data, file.images);
  if (previewDataUrl) await applyImportedPreview(preset, previewDataUrl, warnings);
  return preset;
}

/** 智绘姬口径:自定义负向词前面烤上官方基线;本插件自己的文件不再重复拼。 */
function importNegative(raw: unknown, ours: boolean, model: string): string {
  const negative = typeof raw === 'string' ? raw.trim() : '';
  if (!negative || ours) return negative;
  return [naiDefaultUndesired(model), negative].filter(Boolean).join(', ');
}

function parsePresetVibes(
  raw: unknown,
  groups: readonly unknown[],
  idMap: ReadonlyMap<string, string>,
): NaiArtistVibeRef[] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const vibe = raw as { groupId?: unknown; selections?: unknown };
  const refs: NaiArtistVibeRef[] = [];
  const seen = new Set<string>();
  const push = (id: unknown, enabled: unknown, strength: unknown) => {
    const newId = typeof id === 'string' ? idMap.get(id) : undefined;
    if (!newId || seen.has(newId)) return;
    seen.add(newId);
    refs.push({ id: newId, enabled: enabled !== false, strength: clampVibeStrength(strength) });
  };
  if (Array.isArray(vibe.selections)) {
    for (const selection of vibe.selections) {
      const sel = selection as { id?: unknown; enabled?: unknown; strength?: unknown } | null;
      if (sel && typeof sel === 'object') push(sel.id, sel.enabled, sel.strength);
    }
  }
  if (!refs.length && typeof vibe.groupId === 'string') {
    for (const member of groupMembers(groups, vibe.groupId)) {
      push(member.id, member.enabled, member.strength);
    }
  }
  return refs;
}

function groupMembers(
  groups: readonly unknown[],
  groupId: string,
): { id?: unknown; enabled?: unknown; strength?: unknown }[] {
  for (const raw of groups) {
    const group = raw as { id?: unknown; members?: unknown } | null;
    if (!group || group.id !== groupId) continue;
    return Array.isArray(group.members)
      ? (group.members as { id?: unknown; enabled?: unknown; strength?: unknown }[])
      : [];
  }
  return [];
}

function resolvePreviewImage(data: Record<string, unknown>, images: Record<string, string>): string {
  const refId = data.previewImageId;
  if (typeof refId === 'string' && images[refId]) return images[refId];
  return typeof data.thumbnail === 'string' ? data.thumbnail : '';
}

function dataUrlBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

async function applyImportedPreview(
  preset: NaiArtistPreset,
  dataUrl: string,
  warnings: string[],
): Promise<void> {
  const prepared = await preparePreviewUpload(dataUrl, preset.name, warnings);
  if (!prepared) return;
  try {
    const path = await uploadUserImage(ARTIST_PREVIEW_FOLDER, preset.id, prepared.base64, prepared.format);
    const oldPath = preset.previewPath;
    preset.previewPath = path;
    if (oldPath && oldPath !== path) await deleteUserImage(oldPath).catch(() => {});
  } catch (error) {
    warnings.push(`「${preset.name}」预览图上传失败:${errorMessage(error)}`);
  }
}

/** 导入的预览图统一压成 512 jpeg(与管理器上传同口径);压不动就按原格式上传。 */
async function preparePreviewUpload(
  dataUrl: string,
  name: string,
  warnings: string[],
): Promise<{ base64: string; format: string } | null> {
  try {
    const jpeg = await makeJpegThumbnail(dataUrl, PREVIEW_MAX_EDGE, PREVIEW_QUALITY);
    return { base64: dataUrlBase64(jpeg), format: 'jpg' };
  } catch {
    const match = /^data:image\/([a-z0-9+.-]+);base64,/i.exec(dataUrl);
    if (!match) {
      warnings.push(`「${name}」预览图不是 base64 图片,已跳过`);
      return null;
    }
    const format = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
    return { base64: dataUrlBase64(dataUrl), format };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
