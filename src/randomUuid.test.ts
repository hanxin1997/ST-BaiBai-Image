import { describe, expect, it, vi } from 'vitest';

import { randomUuid } from '@/randomUuid';

describe('randomUuid', () => {
  it('generates a UUID v4 without Web Crypto', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    expect(randomUuid()).toBe('00000000-0000-4000-8000-000000000000');
  });
});
