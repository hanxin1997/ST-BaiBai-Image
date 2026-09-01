/**
 * 把模型给出的插入位置从「请求开始时的正文」平移到「写回时的正文」。
 *
 * 为什么需要:副 API 分析要几秒到几十秒,期间别的插件常改正文(翻译、润色、追加状态栏、
 * 重写八股句)。旧实现在写回前整段比对正文,一处不同就放弃——哪怕改的是与画面毫无关系
 * 的部分,tag 也一并不注入。现在改成以「清洗后的叙事行」为锚重新定位:改动无关部分则
 * 位置分毫不动,真被改写的句子也照样落回它在新正文里的对应位置,不再丢 tag。
 *
 * 对齐口径:两份 segment 列表(prepareTargetText 的产物,天然只含清洗后活下来的叙事行)
 * 先按文本相等求最长公共子序列作骨架,骨架之间的空隙按序号比例配对——空隙里旧 1 条新 1 条
 * 正好是「那句话被改写了」,精确命中而非近似;整句消失的行回落到前一个已配对锚点。
 *
 * 落点只能是当前正文的 segment,不能是裸行号:这样 tag 绝不会掉进别的插件刚追加的
 * 状态栏块内部——那些块在清洗阶段就已不构成 segment。
 */

import { prepareTargetText, type TargetSegment } from '@/autoTag/clean';
import type { ImageInsertion } from '@/autoTag/protocol';

/** 超过此规模不跑 O(n*m) DP。正常楼层的叙事行数远小于此,超了只按比例映射。 */
const LCS_CELL_LIMIT = 250_000;

/**
 * 文本相等的最长公共子序列,返回递增的 (旧序号, 新序号) 配对。
 * 规模超限时返回空骨架,交给调用方整体按比例映射(退化但不出错)。
 */
function lcsPairs(oldTexts: string[], newTexts: string[]): Array<[number, number]> {
  const n = oldTexts.length;
  const m = newTexts.length;
  if (!n || !m || n * m > LCS_CELL_LIMIT) return [];

  // dp[i][j] = oldTexts[i..] 与 newTexts[j..] 的 LCS 长度(扁平化成一维,行宽 m+1)
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        oldTexts[i] === newTexts[j]
          ? dp[(i + 1) * width + (j + 1)] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldTexts[i] === newTexts[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/**
 * 旧 segment 序号 → 新 segment 序号的映射;配不上的位置留 -1。
 * 骨架(文本原样存在的行)先钉住,再在骨架切出的空隙里按序号比例配对。
 */
function alignSegments(oldTexts: string[], newTexts: string[]): number[] {
  const mapped = new Array<number>(oldTexts.length).fill(-1);
  const skeleton = lcsPairs(oldTexts, newTexts);

  let prevOld = -1;
  let prevNew = -1;
  const fillGap = (oldEnd: number, newEnd: number): void => {
    const oldLen = oldEnd - prevOld - 1;
    const newLen = newEnd - prevNew - 1;
    if (oldLen <= 0 || newLen <= 0) return;
    for (let k = 0; k < oldLen; k += 1) {
      mapped[prevOld + 1 + k] = prevNew + 1 + Math.floor((k * newLen) / oldLen);
    }
  };

  for (const [i, j] of skeleton) {
    fillGap(i, j);
    mapped[i] = j;
    prevOld = i;
    prevNew = j;
  }
  fillGap(oldTexts.length, newTexts.length);
  return mapped;
}

/** 从 index 起向前找最近的已配对位置,前面没有再往后找。全都没有返回 -1。 */
function nearestMapped(mapped: number[], index: number): number {
  for (let i = index; i >= 0; i -= 1) {
    if (mapped[i] >= 0) return mapped[i];
  }
  for (let i = index + 1; i < mapped.length; i += 1) {
    if (mapped[i] >= 0) return mapped[i];
  }
  return -1;
}

export interface RebaseReport {
  /** 锚点句原样存在:位置等价于没动。 */
  anchored: number;
  /** 锚点句被改写:按对齐结果落到它在新正文里的对应句。 */
  remapped: number;
  /** 锚点句整句消失:顺延到前一个锚点(宁可位置偏一点,也不丢 tag)。 */
  drifted: number;
}

export interface RebaseResult {
  images: ImageInsertion[];
  report: RebaseReport;
}

/**
 * 按当前正文重算每张图的插入行。
 *
 * plannedSegments 是模型当时看到的那份 segment 列表(runner 里 preparedTarget.segments),
 * currentText 是即将写回的正文基底。返回的 images 已按新行号升序(同行保持原相对顺序),
 * 可直接交给 injectImageTags。
 *
 * 返回 null 只在真正无从下手时:当前正文清洗后一条叙事行都不剩——此时任何落点都是瞎猜。
 * 句子被改写、被删、被整段追加内容都不算无从下手,一律给出落点。
 */
export function rebaseImagePositions(
  currentText: string,
  plannedSegments: TargetSegment[],
  images: ImageInsertion[],
  stripTags: string[],
): RebaseResult | null {
  const report: RebaseReport = { anchored: 0, remapped: 0, drifted: 0 };
  if (!images.length) return { images: [], report };

  const newSegments = prepareTargetText(currentText, stripTags).segments;
  if (!newSegments.length) return null;

  const oldByLine = new Map(plannedSegments.map((segment, index) => [segment.sourceLine, index]));
  const mapped = alignSegments(
    plannedSegments.map(segment => segment.text),
    newSegments.map(segment => segment.text),
  );

  const out: ImageInsertion[] = [];
  for (const image of images) {
    const oldIndex = oldByLine.get(image.sourceLine);
    // sourceLine 本就来自 plannedSegments,对不上说明调用方传错了列表
    if (oldIndex === undefined) return null;
    const direct = mapped[oldIndex];
    const target = direct >= 0 ? direct : nearestMapped(mapped, oldIndex);
    if (target < 0) return null;

    if (direct < 0) report.drifted += 1;
    else if (newSegments[target].text === plannedSegments[oldIndex].text) report.anchored += 1;
    else report.remapped += 1;
    out.push({ ...image, sourceLine: newSegments[target].sourceLine });
  }

  // 升序保证叙事顺序单调;sort 稳定,落到同一行的图片保持模型给出的原相对顺序
  out.sort((left, right) => left.sourceLine - right.sourceLine);
  return { images: out, report };
}
