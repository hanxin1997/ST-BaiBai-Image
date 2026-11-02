import { describe, expect, it } from 'vitest';

import { nextEditorState } from '@/floor/promptEditor';

/**
 * 「AI 重写提示词」落盘后,弹窗要从正文重读这一槽的 tag 回填输入框。
 *
 * 入口在编辑弹窗里,而重写是 runner 独立写正文的 —— 两个写手共用一条 tag。
 * 弹窗持有的 rawTag 是写回 CAS 的凭据,回填时漏刷它,用户接着点「应用」就会被
 * 「这条 tag 已被改动」挡回去,而改动它的正是自己刚触发的这次重写。
 */

const TAG_A = '<bbi_image><tag>1girl, classroom</tag></bbi_image>';
const TAG_B = '<bbi_image><tag>1girl, rooftop, sunset</tag></bbi_image>';
const TAG_C = '<bbi_image><tag>cat</tag></bbi_image>';

describe('nextEditorState', () => {
  it('正文里的 tag 换了新的:rawTag 与 content 一起换', () => {
    const next = nextEditorState(`前文 ${TAG_B} 后文`, 0, TAG_A);
    // 命门:两者必须同时更新,只更新 content 会让后续「应用」撞上 CAS
    expect(next?.rawTag).toBe(TAG_B);
    expect(next?.content.tag).toBe('1girl, rooftop, sunset');
  });

  it('按 seq 取,不碰同楼其它槽位', () => {
    const next = nextEditorState(`${TAG_C}\n${TAG_B}`, 1, TAG_A);
    expect(next?.rawTag).toBe(TAG_B);
  });

  it('原文没变就什么都不动(别拿等价内容去覆盖用户的草稿)', () => {
    expect(nextEditorState(`前文 ${TAG_A} 后文`, 0, TAG_A)).toBeNull();
  });

  it('seq 已不存在(tag 被删/数量变了)时不动', () => {
    expect(nextEditorState(TAG_A, 3, TAG_A)).toBeNull();
  });

  it('正文读不到(楼层已没了)时不动', () => {
    expect(nextEditorState(undefined, 0, TAG_A)).toBeNull();
  });
});
