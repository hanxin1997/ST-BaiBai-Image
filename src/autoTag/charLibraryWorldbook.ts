import { buildLibraryText } from '@/autoTag/charAnchors';
import { charTagLib } from '@/state/charTags';
import { settings } from '@/state/settings';
import {
  deleteWorldInfoBook,
  getWorldInfoBook,
  saveWorldInfoBook,
  type WorldInfoBook,
  type WorldInfoEntryRaw,
} from '@/st/worldinfo';

/**
 * 常驻世界书模式(可选,默认关):把当前聊天角色库写进「直接角色外貌」的 constant 条目。
 *
 * 与临时注入的区别:
 * - 临时注入:每次请求 push system,请求结束消失,不写文件;换聊天/换卡永远是最新。
 * - 常驻:写全局世界书,世界书列表里能看到;但多聊天会互相覆盖,切聊天必须重写。
 *
 * 条目内容与临时注入同源(buildLibraryText),不会各存一份。
 */

const ENTRY_NOTE =
  '【使用说明】写正文与 image### 时,角色固定外貌照抄上方字段,不要改写;@角色名 会被插件替换为库中最新外貌。';

function entryContent(): string {
  const library = buildLibraryText(charTagLib.entries).trim();
  return library ? `${library}\n${ENTRY_NOTE}` : '';
}

/** 新条目的完整默认字段:ST 前端新建条目时也是这一套,缺字段会让编辑器显示异常。 */
function newEntry(uid: number, comment: string, content: string): WorldInfoEntryRaw {
  return {
    uid,
    key: [],
    keysecondary: [],
    comment,
    content,
    constant: true,
    vectorized: false,
    selective: false,
    selectiveLogic: 0,
    addMemo: true,
    order: 100,
    position: 0,
    disable: !content,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: false,
    probability: 100,
    useProbability: true,
    depth: 4,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: '',
    role: 0,
    sticky: 0,
    cooldown: 0,
    delay: 0,
  };
}

/** 找到插件维护的那条(按 comment 匹配);没有返回 null。 */
function findEntryKey(book: WorldInfoBook, comment: string): string | null {
  for (const [key, entry] of Object.entries(book.entries)) {
    if (entry?.comment === comment) return key;
  }
  return null;
}

/** 把当前聊天角色库写进常驻条目;开关关着时什么都不做。 */
export async function syncCharLibraryWorldbook(): Promise<void> {
  if (!settings.autoTag.charLibraryWorldbook) return;
  const bookName = settings.autoTag.charLibraryWorldbookName;
  const entryName = settings.autoTag.charLibraryEntryName;
  const content = entryContent();
  const book = (await getWorldInfoBook(bookName)) ?? { entries: {} };
  const key = findEntryKey(book, entryName);
  if (key === null) {
    const uid = Object.keys(book.entries).length;
    book.entries[String(uid)] = newEntry(uid, entryName, content);
  } else {
    book.entries[key] = { ...book.entries[key], content, disable: !content };
  }
  await saveWorldInfoBook(bookName, book);
}

/** 关闭开关时清空条目内容(保留条目),避免残留旧聊天外貌。 */
export async function clearCharLibraryWorldbook(): Promise<void> {
  const bookName = settings.autoTag.charLibraryWorldbookName;
  const entryName = settings.autoTag.charLibraryEntryName;
  const book = await getWorldInfoBook(bookName);
  if (!book) return;
  const key = findEntryKey(book, entryName);
  if (key === null) return;
  book.entries[key] = { ...book.entries[key], content: '', disable: true };
  await saveWorldInfoBook(bookName, book);
}

/** 删除整本专用世界书(设置页按钮)。 */
export async function deleteCharLibraryWorldbook(): Promise<void> {
  await deleteWorldInfoBook(settings.autoTag.charLibraryWorldbookName);
}
