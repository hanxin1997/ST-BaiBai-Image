import { getContext, type STChatCompletionSettings, type STPresetOrder } from '@/st/context';
import type { AutoTagSettings } from '@/state/settings';

/**
 * 破限词的「跟随酒馆预设」来源(只读,绝不写回酒馆)。
 *
 * 酒馆把当前聊天补全预设实时放在 `getContext().chatCompletionSettings`(即 oai_settings):
 * - `prompts[]`:预设里的全部提示词条目(含 main / nsfw / jailbreak / 自定义条目);
 * - `prompt_order[]`:每个角色/全局的启用状态与顺序,聊天补全的全局顺序用 dummy id 100001;
 * - `preset_settings_openai`:当前预设名。
 *
 * 本模块只负责「读当前预设 → 按用户勾选拼文本」,不做任何持久化。
 */

/** 聊天补全的全局提示词顺序表 id(ST PromptManager 的 promptOrder.dummyId)。 */
const GLOBAL_ORDER_ID = 100001;
/** 默认/角色顺序表 id,作为旧预设的兜底。 */
const DEFAULT_ORDER_ID = 100000;

/** 一条可在设置页勾选的预设提示词。 */
export interface StPresetEntry {
  identifier: string;
  name: string;
  content: string;
  /** 酒馆里是否启用;未启用的条目即使勾选也不会被拼接。 */
  enabled: boolean;
}

export interface StPresetSnapshot {
  presetName: string;
  entries: StPresetEntry[];
}

let fallbackWarned = false;

/** 取当前生效的顺序表:全局 100001 → 默认 100000 → 第一条非空顺序表。 */
function pickOrder(orders: STPresetOrder[] | undefined): STPresetOrder['order'] {
  if (!Array.isArray(orders)) return [];
  const byId = (id: number) => orders.find(order => String(order?.character_id) === String(id));
  const candidates = [byId(GLOBAL_ORDER_ID), byId(DEFAULT_ORDER_ID), ...orders];
  for (const candidate of candidates) {
    if (Array.isArray(candidate?.order) && candidate.order.length) return candidate.order;
  }
  return [];
}

/**
 * 从一份聊天补全设置里抽出可拼接的提示词条目(纯函数)。
 * 跳过重复 identifier、marker 占位项、非系统提示词条目与空内容;顺序跟预设一致。
 */
export function readPresetEntries(settings: STChatCompletionSettings | undefined): StPresetEntry[] {
  if (!settings) return [];
  const byId = new Map<string, { name: string; content: string }>();
  for (const prompt of Array.isArray(settings.prompts) ? settings.prompts : []) {
    const identifier = typeof prompt?.identifier === 'string' ? prompt.identifier : '';
    if (!identifier || byId.has(identifier)) continue;
    if (prompt.marker === true || prompt.system_prompt === false) continue;
    const content = typeof prompt.content === 'string' ? prompt.content.trim() : '';
    if (!content) continue;
    byId.set(identifier, {
      name: typeof prompt.name === 'string' && prompt.name.trim() ? prompt.name.trim() : identifier,
      content,
    });
  }

  const entries: StPresetEntry[] = [];
  const seen = new Set<string>();
  for (const order of pickOrder(settings.prompt_order) ?? []) {
    const identifier = typeof order?.identifier === 'string' ? order.identifier : '';
    const prompt = identifier ? byId.get(identifier) : undefined;
    if (!prompt || seen.has(identifier)) continue;
    seen.add(identifier);
    entries.push({ identifier, ...prompt, enabled: order.enabled === true });
  }
  return entries;
}

/** 读取酒馆当前聊天补全预设;读不到返回 null(旧版酒馆 / 非浏览器环境)。 */
export function readCurrentChatPreset(): StPresetSnapshot | null {
  const settings = getContext()?.chatCompletionSettings;
  if (!settings) return null;
  return {
    presetName:
      typeof settings.preset_settings_openai === 'string' ? settings.preset_settings_openai : '',
    entries: readPresetEntries(settings),
  };
}

/** 展开 ST 宏({{char}} 等);宿主没提供或展开失败时保留原文。 */
function expandMacros(text: string): string {
  const substitute = getContext()?.substituteParams;
  if (typeof substitute !== 'function') return text;
  try {
    const expanded = substitute(text);
    return typeof expanded === 'string' ? expanded : text;
  } catch {
    return text;
  }
}

/**
 * 按勾选的 identifier 取当前预设文本:只拼「勾选 ∩ 存在 ∩ 酒馆启用 ∩ 非空」的条目,
 * 顺序跟预设顺序。读不到/全空返回空串,由调用方回退。
 */
export function resolvePresetJailbreak(identifiers: readonly string[]): string {
  if (!identifiers.length) return '';
  const settings = getContext()?.chatCompletionSettings;
  if (!settings) return '';
  const wanted = new Set(identifiers);
  const texts: string[] = [];
  for (const entry of readPresetEntries(settings)) {
    if (!entry.enabled || !wanted.has(entry.identifier)) continue;
    const text = expandMacros(entry.content).trim();
    if (text) texts.push(text);
  }
  return texts.join('\n\n');
}

/**
 * 解析最终破限词:stPreset 有内容用预设;否则回退自定义文本,再回退内置默认。
 * 与改动前的 `custom || builtin` 逐字一致——没切到预设模式的用户零变化。
 */
export function resolveJailbreakPrompt(options: AutoTagSettings, builtin: string): string {
  const custom = (options.prompts?.jailbreak ?? '').trim();
  const source = options.jailbreakSource;
  if (source?.mode !== 'stPreset') return custom || builtin;

  const presetText = resolvePresetJailbreak(source.presetEntries ?? []);
  if (presetText) return presetText;
  if (!fallbackWarned) {
    fallbackWarned = true;
    console.warn('[柏宝绘] 酒馆预设里取不到所选的破限词条目，已回退自定义文本/内置默认');
  }
  return custom || builtin;
}
