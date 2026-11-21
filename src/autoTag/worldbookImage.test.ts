import { describe, expect, it } from 'vitest';

import {
  convertWorldbookImages,
  detectWorldbookImageFormat,
  parseWorldbookImage,
} from '@/autoTag/worldbookImage';

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

describe('世界书生图:自动认格式', () => {
  it('detectWorldbookImageFormat 三种格式各自认得出来', () => {
    expect(detectWorldbookImageFormat('Scene Composition: indoors;Character 1 Prompt: 1girl')).toBe('nai');
    expect(detectWorldbookImageFormat('size:832x1216; Scene: indoors; Char1: 1girl')).toBe('anima');
    expect(detectWorldbookImageFormat('1girl, silver hair, cinematic lighting, aspect ratio 16:9')).toBe(
      'prompt',
    );
  });

  it('NAI 的 `Scene Composition` 不会被 anima 的 `Scene` 抢先读歪', () => {
    const content = parseWorldbookImage(
      'Scene Composition: indoors, rain;Character 1 Prompt: 1girl, wet hair;Character 1 UC: bad hands',
      'auto',
      'characters',
    );
    expect(content?.tag).toBe('indoors, rain');
    expect(content?.characters[0]?.uc).toBe('bad hands');
  });

  it('anima 的 size 换算成画幅', () => {
    const content = parseWorldbookImage(
      'size:832x1216; Scene: indoors; Char1: 1girl; Description: A girl stands.',
      'auto',
      'characters',
    );
    expect(content?.size).toBe('portrait');
  });

  it('优先格式选 NAI 时,anima 块仍能读出来(换世界书不用回来改设置)', () => {
    const result = convertWorldbookImages(
      'image###size:1216x832; Scene: beach; Char1: 小雪 | 1girl###',
      'nai',
      'characters',
    );
    expect(result.converted).toBe(1);
    expect(result.formats).toEqual(['anima']);
    expect(result.text).toContain('小雪');
  });
});

describe('世界书生图:完整提示词模板(<imgthink> 外壳)', () => {
  const block = [
    '<image>',
    '<imgthink>',
    '分析：复杂场景类型 + 多角色核心剧情。nsfw。',
    '确认角色：小雪',
    '调用判定：按 <调用规则> 调用',
    '</imgthink>',
    'image###1girl, silver hair, white dress, cinematic lighting, depth of field, aspect ratio 16:9, 1344x768###',
    '</image>',
  ].join('\n');

  it('提示词整条读成 tag,末尾分辨率换算画幅并去掉', () => {
    const content = parseWorldbookImage(
      '1girl, silver hair, white dress, cinematic lighting, depth of field, aspect ratio 16:9, 1344x768',
      'auto',
      'characters',
    );
    expect(content?.tag).toBe('1girl, silver hair, white dress, cinematic lighting, depth of field');
    expect(content?.size).toBe('landscape');
    expect(content?.characters).toEqual([]);
  });

  it('竖屏比例同样认', () => {
    const content = parseWorldbookImage('1girl, standing, aspect ratio 9:16, 768x1344', 'auto', 'characters');
    expect(content?.tag).toBe('1girl, standing');
    expect(content?.size).toBe('portrait');
  });

  it('convertWorldbookImages 把整块换成卡片,思考块与 <image> 壳都不留在正文里', () => {
    const result = convertWorldbookImages(`正文开头\n${block}\n正文结尾`, 'auto', 'characters');
    expect(result.converted).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.formats).toEqual(['prompt']);
    expect(result.text).toContain('正文开头');
    expect(result.text).toContain('正文结尾');
    expect(result.text).toContain('<bbi_image>1girl, silver hair');
    expect(result.text).toContain('<size>landscape</size>');
    expect(result.text).not.toContain('<imgthink>');
    expect(result.text).not.toContain('确认角色');
    expect(result.text).not.toContain('<image>');
  });

  it('没有分辨率尾巴时按竖屏', () => {
    const content = parseWorldbookImage('1girl, silver hair, cinematic lighting', 'auto', 'characters');
    expect(content?.tag).toBe('1girl, silver hair, cinematic lighting');
    expect(content?.size).toBe('portrait');
  });

  it('结构化键名残骸不当提示词读:原样保留并计 skipped', () => {
    const result = convertWorldbookImages('image###Scene Composition:###', 'auto', 'characters');
    expect(result.converted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.text).toBe('image###Scene Composition:###');
  });

  it('正常提示词里恰好带 `description:` 也照读,不当成结构化残骸', () => {
    const content = parseWorldbookImage(
      '1girl, silver hair, description: long braid, cinematic lighting',
      'auto',
      'characters',
    );
    expect(content?.tag).toContain('long braid');
    expect(content?.tag).toContain('cinematic lighting');
  });
});

describe('世界书生图:外壳与多块混排', () => {
  it('绘境物语的四行连体:标题留在正文,<image> 壳被吃掉', () => {
    const text = [
      '【小雪·推开教室门】',
      '<image>',
      'image###Scene Composition: indoors, classroom;Character 1 Prompt: 小雪 | 1girl, long black hair |centers:C3###',
      '</image>',
    ].join('\n');
    const result = convertWorldbookImages(text, 'auto', 'characters');
    expect(result.converted).toBe(1);
    expect(result.formats).toEqual(['nai']);
    expect(result.text).toContain('【小雪·推开教室门】');
    expect(result.text).toContain('<bbi_image>indoors, classroom');
    expect(result.text).not.toContain('<image>');
  });

  it('anima 的 <font> 标题 + regex 占位 + <Tag_think>:只清思考块与占位行', () => {
    const text = [
      '<image>',
      '<font color="steelblue">[小巷]</font>',
      'regex:xxxxx',
      '<Tag_think>',
      '【继承】○初始状态',
      '</Tag_think>',
      'image###indoors, alley, night, 1girl, solo, aspect ratio 16:9, 1344x768###',
      '</image>',
    ].join('\n');
    const result = convertWorldbookImages(text, 'auto', 'characters');
    expect(result.converted).toBe(1);
    expect(result.formats).toEqual(['prompt']);
    expect(result.text).toContain('<size>landscape</size>');
    expect(result.text).toContain('[小巷]');
    expect(result.text).not.toContain('Tag_think');
    expect(result.text).not.toContain('regex:xxxxx');
    expect(result.text).not.toContain('【继承】');
  });

  it('同一楼里两种格式混排:各自认、按出现顺序报格式', () => {
    const text = [
      'image###Scene Composition: indoors;Character 1 Prompt: 1girl###',
      'image###1boy, standing, aspect ratio 16:9, 1344x768###',
    ].join('\n');
    const result = convertWorldbookImages(text, 'auto', 'characters');
    expect(result.converted).toBe(2);
    expect(result.formats).toEqual(['nai', 'prompt']);
    expect(result.text).toContain('<size>portrait</size>');
    expect(result.text).toContain('<size>landscape</size>');
  });
});
