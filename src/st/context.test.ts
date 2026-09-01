import { describe, expect, it } from 'vitest';

import { isAiStoryMessage, isStoryMessage, type STMessage } from '@/st/context';

function msg(over: Partial<STMessage> = {}): STMessage {
  return { name: 'Char', is_user: false, is_system: false, mes: '她推开门。', ...over };
}

describe('isStoryMessage', () => {
  it('accepts ordinary AI and user floors', () => {
    expect(isStoryMessage(msg())).toBe(true);
    expect(isStoryMessage(msg({ is_user: true, name: 'User' }))).toBe(true);
  });

  it('accepts a floor hidden by /hide — is_system alone is not a system message', () => {
    // ST 的 /hide 只翻 is_system、不碰 extra(chats.js hideChatMessageRange),
    // 语义是「不进提示词」而非「不是剧情」。楼层按钮与自动 tag 都得照跑。
    expect(isStoryMessage(msg({ is_system: true }))).toBe(true);
  });

  it('rejects real ST system messages (they carry a string extra.type)', () => {
    expect(isStoryMessage(msg({ is_system: true, extra: { type: 'narrator' } }))).toBe(false);
    expect(isStoryMessage(msg({ is_system: true, extra: { type: 'comment' } }))).toBe(false);
  });

  it('ignores extra.type on a floor that is not is_system', () => {
    // /role assistant 会 delete extra.type,但历史消息里可能有残留;is_system=false 时不算系统楼
    expect(isStoryMessage(msg({ extra: { type: 'narrator' } }))).toBe(true);
  });

  it('rejects missing, empty and blank text', () => {
    expect(isStoryMessage(undefined)).toBe(false);
    expect(isStoryMessage(msg({ mes: '' }))).toBe(false);
    expect(isStoryMessage(msg({ mes: '  \n ' }))).toBe(false);
    expect(isStoryMessage(msg({ mes: undefined as unknown as string }))).toBe(false);
  });
});

describe('isAiStoryMessage', () => {
  it('is isStoryMessage minus user floors', () => {
    expect(isAiStoryMessage(msg())).toBe(true);
    expect(isAiStoryMessage(msg({ is_system: true }))).toBe(true);
    expect(isAiStoryMessage(msg({ is_user: true }))).toBe(false);
    expect(isAiStoryMessage(msg({ is_system: true, extra: { type: 'narrator' } }))).toBe(false);
    expect(isAiStoryMessage(undefined)).toBe(false);
  });
});
