import { describe, expect, it } from 'vitest';

import {
  clearAutoGenerateFlags,
  clearAutoGenerateForFloor,
  consumeAutoGenerate,
  markForAutoGenerate,
  shouldAutoGenerate,
  type AutoGeneratePhase,
} from '@/floor/autoGenerate';

describe('auto generate flags', () => {
  it('consume returns the mode once for a marked slot, then null', () => {
    clearAutoGenerateFlags();
    markForAutoGenerate('chat1', 5, 0, 0);
    expect(consumeAutoGenerate('chat1', 5, 0, 0)).toBe('auto');
    expect(consumeAutoGenerate('chat1', 5, 0, 0)).toBe(null);
  });

  it('distinguishes slots by chat/message/swipe/seq', () => {
    clearAutoGenerateFlags();
    markForAutoGenerate('chat1', 5, 0, 0);
    expect(consumeAutoGenerate('chat1', 5, 0, 1)).toBe(null);
    expect(consumeAutoGenerate('chat1', 5, 1, 0)).toBe(null);
    expect(consumeAutoGenerate('chat2', 5, 0, 0)).toBe(null);
    expect(consumeAutoGenerate('chat1', 5, 0, 0)).toBe('auto');
  });

  it('clearAutoGenerateForFloor removes only that floor', () => {
    clearAutoGenerateFlags();
    markForAutoGenerate('chat1', 5, 0, 0);
    markForAutoGenerate('chat1', 5, 0, 1);
    markForAutoGenerate('chat1', 6, 0, 0);
    clearAutoGenerateForFloor('chat1', 5);
    expect(consumeAutoGenerate('chat1', 5, 0, 0)).toBe(null);
    expect(consumeAutoGenerate('chat1', 5, 0, 1)).toBe(null);
    expect(consumeAutoGenerate('chat1', 6, 0, 0)).toBe('auto');
  });

  it('clearAutoGenerateFlags wipes everything', () => {
    markForAutoGenerate('chat1', 5, 0, 0);
    markForAutoGenerate('chat2', 1, 0, 0);
    clearAutoGenerateFlags();
    expect(consumeAutoGenerate('chat1', 5, 0, 0)).toBe(null);
    expect(consumeAutoGenerate('chat2', 1, 0, 0)).toBe(null);
  });

  it('keeps the force mode through a mark/consume round trip', () => {
    clearAutoGenerateFlags();
    markForAutoGenerate('chat1', 5, 0, 0, 'force');
    expect(consumeAutoGenerate('chat1', 5, 0, 0)).toBe('force');
  });

  it('re-marking the same slot replaces its mode (force wins over a leftover auto)', () => {
    clearAutoGenerateFlags();
    markForAutoGenerate('chat1', 5, 0, 0, 'auto');
    markForAutoGenerate('chat1', 5, 0, 0, 'force');
    expect(consumeAutoGenerate('chat1', 5, 0, 0)).toBe('force');
    expect(consumeAutoGenerate('chat1', 5, 0, 0)).toBe(null);
  });
});

describe('shouldAutoGenerate', () => {
  it('lets auto fire on stale — the tag changed and no image matches it yet', () => {
    // 曾经这里只放 pending,楼层「重新生成 tag」在已出过图的楼层上因此静默失效:
    // 新 tag 写进正文了,卡片却停在旧图不动。stale 的语义正是「该出新图了」。
    expect(shouldAutoGenerate('auto', 'stale')).toBe(true);
  });

  it('lets auto fire on a truly empty slot', () => {
    expect(shouldAutoGenerate('auto', 'pending')).toBe(true);
  });

  it('blocks auto when this prompt already has a result or work in flight', () => {
    const blocked: AutoGeneratePhase[] = ['ready', 'queued', 'generating', 'error'];
    for (const phase of blocked) {
      expect(shouldAutoGenerate('auto', phase)).toBe(false);
    }
  });

  it('lets force fire in every phase — the user explicitly asked for a new image', () => {
    const all: AutoGeneratePhase[] = [
      'pending',
      'queued',
      'generating',
      'ready',
      'stale',
      'error',
    ];
    for (const phase of all) {
      expect(shouldAutoGenerate('force', phase)).toBe(true);
    }
  });
});
