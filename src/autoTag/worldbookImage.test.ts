import { describe, expect, it } from 'vitest';

import { convertWorldbookImages, parseWorldbookImage } from '@/autoTag/worldbookImage';

describe('世界书生图:角色名解析', () => {
  it('NAI: `名字 | tag` 解析出角色名与外貌', () => {
    const content = parseWorldbookImage(
      'Scene Composition: indoors, classroom;Character 1 Prompt: 小雪 | 1girl, long black hair, blue eyes |centers:C3',
      'nai',
      'characters',
    );
    expect(content?.characters[0]?.name).toBe('小雪');
    expect(content?.characters[0]?.tag).toContain('long black hair');
    expect(content?.characters[0]?.center).toBe('C3');
  });

  it('没有竖线 → 兼容旧格式,名字回落「角色 N」', () => {
    const content = parseWorldbookImage(
      'Scene Composition: indoors;Character 1 Prompt: 1girl, long black hair',
      'nai',
      'characters',
    );
    expect(content?.characters[0]?.name).toBe('角色 1');
    expect(content?.characters[0]?.tag).toContain('long black hair');
  });

  it('anima: `Char1: 名字 | tag`', () => {
    const content = parseWorldbookImage(
      'size:832x1216; Scene: indoors, classroom; Char1: 小雪 | 1girl, long black hair; Description: A girl stands.',
      'anima',
      'characters',
    );
    expect(content?.characters[0]?.name).toBe('小雪');
    expect(content?.characters[0]?.tag).toContain('long black hair');
  });

  it('convertWorldbookImages 保留角色名', () => {
    const result = convertWorldbookImages(
      '正文 image###Scene Composition: indoors;Character 1 Prompt: 小雪 | 1girl, long black hair### 结尾',
      'nai',
      'characters',
    );
    expect(result.converted).toBe(1);
    expect(result.text).toContain('<bbi_image>');
    expect(result.text).toContain('小雪');
  });
});
