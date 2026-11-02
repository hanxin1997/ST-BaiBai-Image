import { describe, expect, it } from 'vitest';

import { buildSlotTaskNote } from '@/autoTag/slotPlan';
import { serializeImageTag } from '@/st/imageTagRegex';

function tag(text: string, nl = ''): string {
  return serializeImageTag({ tag: text, nl, negative: '', characters: [], size: 'portrait' });
}

describe('buildSlotTaskNote', () => {
  it('说明只重写第 N 张、画面不变,并要求恰好 1 张', () => {
    const source = [
      `正文`,
      tag('1girl, classroom'),
      tag('1boy, rooftop', 'A boy on the roof.'),
      tag('cat, windowsill'),
    ].join('\n');
    const note = buildSlotTaskNote(source, 1);
    expect(note).toContain('【本次只重写第 2 张的提示词】');
    expect(note).toContain('不要另选画面');
    expect(note).toContain('images 数组必须恰好返回 1 项');
  });

  /**
   * 这条是本功能的命门:写回侧按 seq 原位替换、根本不看模型返回的 position,
   * 所以「换不换画面」完全由这段措辞决定。旧版写的是「另选一个与它们明显不同的
   * 瞬间」,导致按钮写着「重写提示词」、模型收到的却是「换个画面」。
   *
   * 注意只能锁**祈使**口径:「不要另选画面」是禁令,含「另选」二字却正是我们要的,
   * 所以不能简单断言不含「另选」。
   */
  it('绝不能出现让模型另选画面的祈使措辞', () => {
    const note = buildSlotTaskNote([tag('1girl, classroom'), tag('1boy, rooftop')].join('\n'), 0);
    expect(note).not.toContain('请为这一张另选');
    expect(note).not.toContain('明显不同的瞬间');
    expect(note).not.toContain('重选');
    // 禁令必须在场
    expect(note).toContain('不要另选画面');
  });

  it('把目标槽位当前的提示词原样喂回去当锚点(不截断)', () => {
    const long = `1girl, ${'detail, '.repeat(60)}classroom`;
    const note = buildSlotTaskNote([tag(long), tag('cat')].join('\n'), 0);
    expect(note).toContain('这一张当前的提示词');
    // 锚点是要模型逐字对照的,必须全文带上——被截断就等于让它猜画面
    expect(note).toContain(long);
  });

  it('列出其余画面时跳过目标槽位,并说明不要抢它们的画面', () => {
    const source = [tag('1girl, classroom'), tag('1boy, rooftop'), tag('cat, windowsill')].join('\n');
    const note = buildSlotTaskNote(source, 1);
    expect(note).toContain('第 1 张：1girl, classroom');
    expect(note).not.toContain('第 2 张：');
    expect(note).toContain('第 3 张：cat, windowsill');
    expect(note).toContain('不要把它们的画面抢过来');
  });

  it('单张楼只有说明,没有其余画面清单', () => {
    const note = buildSlotTaskNote(tag('1girl, sunset'), 0);
    expect(note).toContain('【本次只重写第 1 张的提示词】');
    expect(note).not.toContain('本楼其余画面');
    // 单张楼照样要给锚点
    expect(note).toContain('1girl, sunset');
  });

  it('正文里没有 tag 时不抛错,也不编造锚点(边界容忍)', () => {
    const note = buildSlotTaskNote('纯正文', 0);
    expect(note).toContain('【本次只重写第 1 张的提示词】');
    expect(note).not.toContain('本楼其余画面');
    expect(note).not.toContain('这一张当前的提示词');
  });

  it('其余画面摘要压成单行并截断,避免把整段提示词灌进备注', () => {
    const long = 'x'.repeat(400);
    const source = [tag('aaa'), tag(long)].join('\n');
    // 目标是第 1 张,所以第 2 张走的是「其余画面」摘要口径 → 要截断
    const note = buildSlotTaskNote(source, 0);
    expect(note).toContain('第 2 张：');
    expect(note).not.toContain(long);
    expect(note).toContain('…');
    // tag / nl 两段之间不得带换行漏进清单(parseImageTagContent 会把 nl 内部换行折成空格,
    // 这里锁的是段与段之间的分隔符也被压成单行)
    const withNl = buildSlotTaskNote(
      [tag('aaa'), tag('1girl', 'A girl.\nSecond line.')].join('\n'),
      0,
    );
    expect(withNl).toContain('第 2 张：1girl / A girl. Second line.');
  });
});
