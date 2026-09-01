import { describe, expect, it } from 'vitest';

import { imageDownloadFileName } from '@/floor/download';

describe('imageDownloadFileName', () => {
  it('keeps Chinese characters in the downloaded filename', () => {
    expect(imageDownloadFileName('/user/files/bbi____.png', '柏宝', 'g123')).toBe(
      'bbi_柏宝_g123.png',
    );
  });

  it('replaces only characters forbidden in filenames', () => {
    expect(imageDownloadFileName('/user/files/image.jpg?x=1', '柏宝/测试:卡', 'g123')).toBe(
      'bbi_柏宝_测试_卡_g123.jpg',
    );
  });
});
