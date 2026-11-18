import type { ChatMsg } from '@/api/client';
import { buildLibraryText, formatEntryForPrompt } from '@/autoTag/charAnchors';
import type { CharTagEntry } from '@/state/charTags';

/**
 * 把「当前聊天角色库」注入主 LLM prompt,并替换 `@角色名` 占位符。
 *
 * 只做临时注入:在 generate_interceptor 里往 messages 里 push 一条 system,
 * 请求结束自然消失——不写世界书、不覆盖、不残留。
 *
 * 库文本与自动 tag 的【角色固定外貌库】同源(buildLibraryText),所以两条路径
 * 看到的字段永远一致,不会各存一份。
 */

/** 注入内容的固定标记:用来判断本次 messages 里是否已经注入过,避免重复。 */
const INJECTION_MARK = '【角色固定外貌库】';

/** 注入说明:告诉主 LLM 这些字段要照抄,以及 @占位符的语义。 */
const INJECTION_NOTE =
  '【使用说明】写正文与 image### 时,角色固定外貌照抄上方字段,不要改写;@角色名 会被插件替换为库中最新外貌。';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 生成要注入的 system 文本;空库返回空串。maxChars > 0 时按字符截断。 */
export function buildCharLibraryInjection(entries: CharTagEntry[], maxChars = 0): string {
  const library = buildLibraryText(entries).trim();
  if (!library) return '';
  const full = `${library}\n${INJECTION_NOTE}`;
  if (maxChars > 0 && full.length > maxChars) {
    return `${full.slice(0, maxChars)}\n…（角色库过长，已截断）`;
  }
  return full;
}

/**
 * 把文本里的 `@角色名` 替换成库中该角色的最新外貌。
 * 只替换库中存在的名字;后面紧跟文字/数字的不算(避免 @小雪儿 命中 @小雪)。
 * 未命中的 @ 原样保留,方便用户发现漏档。
 */
export function replaceCharPlaceholders(text: string, entries: CharTagEntry[]): string {
  let result = text;
  for (const entry of entries) {
    const name = entry.name.trim();
    if (!name) continue;
    const pattern = new RegExp(`@${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'gu');
    result = result.replace(pattern, () => formatEntryForPrompt(entry).replace(/^- /, ''));
  }
  return result;
}

export interface CharLibraryInjectionOptions {
  /** 是否替换 @角色名 占位符。 */
  replacePlaceholders: boolean;
  /** 注入文本的字符上限;0 = 不限制。 */
  maxChars: number;
}

/**
 * 往主 LLM 的 messages 里注入角色库(临时,内存)。
 *
 * - 先替换所有消息里的 @角色名(含正文、酒馆世界书);
 * - 再 push 一条 system;已有【角色固定外貌库】时不再重复注入。
 *
 * 直接改传入的数组(酒馆 generate_interceptor 的 chat 就是它)。
 */
export function injectCharLibrary(
  chat: ChatMsg[],
  entries: CharTagEntry[],
  options: CharLibraryInjectionOptions,
): void {
  if (!entries.length || !chat.length) return;
  if (options.replacePlaceholders) {
    for (const message of chat) {
      if (typeof message.content === 'string' && message.content.includes('@')) {
        message.content = replaceCharPlaceholders(message.content, entries);
      }
    }
  }
  if (chat.some(message => typeof message.content === 'string' && message.content.includes(INJECTION_MARK))) {
    return;
  }
  const injection = buildCharLibraryInjection(entries, options.maxChars);
  if (!injection) return;
  // BEFORE_PROMPT 的语义:放在 messages 最前,比世界书与聊天历史更强势。
  chat.unshift({ role: 'system', content: injection });
}
