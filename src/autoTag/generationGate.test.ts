import { beforeEach, describe, expect, it } from 'vitest';
import { beginGeneration, clearGeneration, consumeGeneration } from '@/autoTag/generationGate';

describe('automatic tag generation gate', () => {
  beforeEach(clearGeneration);

  it('ignores message renders that were not preceded by a real generation', () => {
    expect(consumeGeneration('chat-a', 'normal')).toBe(false);
  });

  it('accepts the matching final render exactly once', () => {
    beginGeneration('chat-a', 'normal', false);

    expect(consumeGeneration('chat-a', 'normal')).toBe(true);
    expect(consumeGeneration('chat-a', 'normal')).toBe(false);
  });

  it('rejects renders from another chat or another render type', () => {
    beginGeneration('chat-a', 'normal', false);

    expect(consumeGeneration('chat-b', 'normal')).toBe(false);
    expect(consumeGeneration('chat-a', 'extension')).toBe(false);
    expect(consumeGeneration('chat-a', 'normal')).toBe(true);
  });

  it('does not arm for dry runs, quiet generations, or impersonation', () => {
    beginGeneration('chat-a', 'normal', true);
    expect(consumeGeneration('chat-a', 'normal')).toBe(false);

    beginGeneration('chat-a', 'quiet', false);
    expect(consumeGeneration('chat-a', 'quiet')).toBe(false);

    beginGeneration('chat-a', 'impersonate', false);
    expect(consumeGeneration('chat-a', 'impersonate')).toBe(false);
  });

  it('can be cancelled when the chat changes or generation stops', () => {
    beginGeneration('chat-a', 'swipe', false);
    clearGeneration();

    expect(consumeGeneration('chat-a', 'swipe')).toBe(false);
  });
});
