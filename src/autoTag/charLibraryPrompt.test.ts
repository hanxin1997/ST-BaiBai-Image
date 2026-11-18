import { describe, expect, it } from 'vitest';

import {
  buildCharLibraryInjection,
  injectCharLibrary,
  replaceCharPlaceholders,
} from '@/autoTag/charLibraryPrompt';
import { emptyCharFields, type CharTagEntry } from '@/state/charTags';

function entry(name: string, hair: string): CharTagEntry {
  return {
    name,
    fields: { ...emptyCharFields(), sex: '1girl', hair, eyes: 'blue eyes' },
    raw: '',
    nl: '',
    source: 'manual',
    desc: '',
    history: [],
  };
}

describe('@角色名 替换', () => {
  it('命中库中名字 → 替换成最新外貌', () => {
    const text = replaceCharPlaceholders('@小雪 站在门口', [entry('小雪', 'long black hair')]);
    expect(text).toContain('long black hair');
    expect(text).not.toContain('@小雪');
  });

  it('后面紧跟文字时不误命中(@小雪儿 不该命中 @小雪)', () => {
    const text = replaceCharPlaceholders('@小雪儿 站在门口', [entry('小雪', 'long black hair')]);
    expect(text).toBe('@小雪儿 站在门口');
  });

  it('库里没有的名字原样保留', () => {
    expect(replaceCharPlaceholders('@路人 走过', [entry('小雪', 'long black hair')])).toBe('@路人 走过');
  });
});

describe('角色库注入文本', () => {
  it('空库 → 空串', () => {
    expect(buildCharLibraryInjection([])).toBe('');
  });

  it('有库 → 含库标记、字段与使用说明', () => {
    const text = buildCharLibraryInjection([entry('小雪', 'long black hair')]);
    expect(text).toContain('【角色固定外貌库】');
    expect(text).toContain('long black hair');
    expect(text).toContain('@角色名');
  });

  it('maxChars > 0 时截断并标注', () => {
    const text = buildCharLibraryInjection([entry('小雪', 'long black hair')], 20);
    expect(text).toContain('已截断');
    expect(text.length).toBeLessThan(120);
  });
});

describe('injectCharLibrary', () => {
  it('把库 push 到 messages 最前,并替换 @角色名', () => {
    const chat = [
      { role: 'system' as const, content: '你是助手' },
      { role: 'user' as const, content: '@小雪 站在门口' },
    ];
    injectCharLibrary(chat, [entry('小雪', 'long black hair')], {
      replacePlaceholders: true,
      maxChars: 0,
    });
    expect(chat[0].content).toContain('【角色固定外貌库】');
    expect(chat.some(message => message.content.includes('long black hair'))).toBe(true);
  });

  it('已经注入过就不再重复', () => {
    const chat = [{ role: 'user' as const, content: 'x' }];
    injectCharLibrary(chat, [entry('小雪', 'long black hair')], {
      replacePlaceholders: false,
      maxChars: 0,
    });
    injectCharLibrary(chat, [entry('小雪', 'long black hair')], {
      replacePlaceholders: false,
      maxChars: 0,
    });
    expect(chat.filter(message => message.content.includes('【角色固定外貌库】')).length).toBe(1);
  });

  it('空库不注入', () => {
    const chat = [{ role: 'user' as const, content: 'x' }];
    injectCharLibrary(chat, [], { replacePlaceholders: true, maxChars: 0 });
    expect(chat).toHaveLength(1);
  });
});
