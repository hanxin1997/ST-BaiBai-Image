import { describe, expect, it } from 'vitest';

import { prepareTargetText } from '@/autoTag/clean';
import { injectImageTags, type ImageInsertion } from '@/autoTag/protocol';
import { rebaseImagePositions } from '@/autoTag/rebase';

function image(sourceLine: number, tag: string): ImageInsertion {
  return {
    position: `P${sourceLine}`,
    sourceLine,
    tag,
    nl: '',
    negative: '',
    characters: [],
    size: 'portrait',
  };
}

/** 按 runner 的口径:模型看到的 segment 列表来自请求开始时的正文。 */
function plan(text: string, stripTags: string[] = []) {
  return prepareTargetText(text, stripTags).segments;
}

/** 落点断言看的是「tag 贴在哪一句之后」,比行号更接近用户能观察到的结果。 */
function lineAfterTag(text: string, tag: string): string {
  const lines = text.split('\n');
  const index = lines.findIndex(line => line.includes(`<bbi_image>${tag}`));
  return index > 0 ? lines[index - 1] : '';
}

describe('rebaseImagePositions', () => {
  it('正文没变:位置分毫不动', () => {
    const text = '第一句\n第二句\n第三句';
    const segments = plan(text);
    const result = rebaseImagePositions(text, segments, [image(1, 'a')], []);
    expect(result?.images[0].sourceLine).toBe(1);
    expect(result?.report).toEqual({ anchored: 1, remapped: 0, drifted: 0 });
  });

  it('别的插件在末尾追加内容:骨架全命中,位置不动', () => {
    const before = '第一句\n第二句\n第三句';
    const after = `${before}\n<statusbar>好感度 +1</statusbar>\n追加的旁注`;
    const segments = plan(before);
    const result = rebaseImagePositions(after, segments, [image(0, 'a'), image(2, 'b')], []);
    expect(result?.images.map(i => i.sourceLine)).toEqual([0, 2]);
    expect(result?.report.anchored).toBe(2);
  });

  it('别的插件在开头插入内容:位置整体平移,仍贴在原来那句之后', () => {
    const before = '第一句\n第二句\n第三句';
    const after = `插进来的新首句\n${before}`;
    const segments = plan(before);
    const result = rebaseImagePositions(after, segments, [image(1, 'a')], []);
    expect(result?.images[0].sourceLine).toBe(2);
    expect(lineAfterTag(injectImageTags(after, result!.images), 'a')).toBe('第二句');
    expect(result?.report.anchored).toBe(1);
  });

  it('八股句被改写:tag 跟着落到改写后的那一句之后(核心场景)', () => {
    const before = '第一句\n【状态】好感度:低\n第三句';
    const after = '第一句\n【状态】好感度:中等偏上\n第三句';
    const segments = plan(before);
    const result = rebaseImagePositions(after, segments, [image(1, 'a')], []);
    expect(result?.images[0].sourceLine).toBe(1);
    expect(lineAfterTag(injectImageTags(after, result!.images), 'a')).toBe('【状态】好感度:中等偏上');
    expect(result?.report).toEqual({ anchored: 0, remapped: 1, drifted: 0 });
  });

  it('全文被润色(每句都改了措辞):逐句对位,一张都不丢', () => {
    const before = '她走进房间\n窗外下着雨\n他抬起头';
    const after = '她缓步走进了房间\n窗外正下着细雨\n他慢慢抬起头';
    const segments = plan(before);
    const result = rebaseImagePositions(after, segments, [image(0, 'a'), image(2, 'b')], []);
    expect(result?.images.map(i => i.sourceLine)).toEqual([0, 2]);
    const injected = injectImageTags(after, result!.images);
    expect(lineAfterTag(injected, 'a')).toBe('她缓步走进了房间');
    expect(lineAfterTag(injected, 'b')).toBe('他慢慢抬起头');
    expect(result?.report.remapped).toBe(2);
  });

  it('锚点句整句被删:顺延到前一段,不丢 tag', () => {
    const before = '第一句\n第二句\n第三句';
    const after = '第一句\n第三句';
    const segments = plan(before);
    const result = rebaseImagePositions(after, segments, [image(1, 'a')], []);
    expect(result?.images[0].sourceLine).toBe(0);
    expect(lineAfterTag(injectImageTags(after, result!.images), 'a')).toBe('第一句');
    expect(result?.report.drifted).toBe(1);
  });

  it('多张图保持叙事顺序单调', () => {
    const before = '一\n二\n三\n四';
    const after = '一\n二改了\n三\n四';
    const segments = plan(before);
    const result = rebaseImagePositions(
      after,
      segments,
      [image(3, 'd'), image(0, 'a'), image(1, 'b')],
      [],
    );
    const lines = result!.images.map(i => i.sourceLine);
    expect(lines).toEqual([...lines].sort((x, y) => x - y));
    expect(lines).toEqual([0, 1, 3]);
  });

  it('落点只取清洗后的叙事行:tag 不会掉进追加的状态栏块里', () => {
    const before = '第一句\n第二句';
    const after = '第一句\n<snow>\n块内第一行\n块内第二行\n</snow>\n第二句';
    const segments = plan(before, ['snow']);
    const result = rebaseImagePositions(after, segments, [image(1, 'a')], ['snow']);
    const injected = injectImageTags(after, result!.images);
    expect(lineAfterTag(injected, 'a')).toBe('第二句');
    // 块内部不得被劈开
    expect(injected).toContain('<snow>\n块内第一行\n块内第二行\n</snow>');
  });

  it('正文被清空/只剩噪声:返回 null 交调用方放弃', () => {
    const segments = plan('第一句\n第二句');
    expect(rebaseImagePositions('', segments, [image(0, 'a')], [])).toBeNull();
    expect(rebaseImagePositions('<snow>只剩状态栏</snow>', segments, [image(0, 'a')], ['snow']))
      .toBeNull();
  });

  it('没有图片时直接返回空结果(不碰正文)', () => {
    const result = rebaseImagePositions('随便', plan('随便'), [], []);
    expect(result).toEqual({ images: [], report: { anchored: 0, remapped: 0, drifted: 0 } });
  });

  it('sourceLine 不属于给定 segment 列表:视为调用方错误,返回 null', () => {
    const segments = plan('第一句\n第二句');
    expect(rebaseImagePositions('第一句\n第二句', segments, [image(99, 'a')], [])).toBeNull();
  });

  it('重复句子不会全部塌到同一行', () => {
    const before = '同一句\n中间\n同一句';
    const after = '同一句\n中间改了\n同一句';
    const segments = plan(before);
    const result = rebaseImagePositions(after, segments, [image(0, 'a'), image(2, 'b')], []);
    expect(result?.images.map(i => i.sourceLine)).toEqual([0, 2]);
  });
});
