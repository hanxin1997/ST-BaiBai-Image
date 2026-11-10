import { requestCompletion, requestViaMainApi, type ChatMsg } from '@/api/client';
import { readBookMemory } from '@/autoTag/bookMemory';
import {
  applyPositionedCharRefs,
  resolveCharAnchors,
  type PositionedCharOp,
} from '@/autoTag/charAnchors';
import { prepareTargetText } from '@/autoTag/clean';
import { beginGeneration, clearGeneration, consumeGeneration } from '@/autoTag/generationGate';
import { autoTagProfile, buildAutoTagMessages, type AutoTagProfile } from '@/autoTag/prompt';
import { rebaseImagePositions, type RebaseReport } from '@/autoTag/rebase';
import { buildSlotTaskNote } from '@/autoTag/slotPlan';
import { convertWorldbookImages, hasWorldbookImage } from '@/autoTag/worldbookImage';
import {
  activeWorldbook,
  buildWorldbookChainMessages,
  parseWorldbookChainPlan,
} from '@/autoTag/worldbookChain';
import {
  BBI_CHAR_EXTRA_KEY,
  CHAR_TAG_FIELDS,
  charTagsBeforeFloor,
  createCharTagNewOp,
  createCharTagSetOp,
  emptyCharFields,
  lockedCharTagNames,
  makeCharTagFloorDelta,
  readCharTagFloorDelta,
  recomputeCharTags,
  type CharTagAutoOp,
  type CharTagField,
} from '@/state/charTags';
import { injectImageTags, parseImagePlan, type ImagePlan } from '@/autoTag/protocol';
import { beginTagNotice, clearTagNotices, type TagNoticeHandle } from '@/autoTag/notice';
import {
  clearAutoGenerateForFloor,
  consumeAutoGenerate,
  markForAutoGenerate,
} from '@/floor/autoGenerate';
import { applyMessageText, type ApplyMessageResult } from '@/st/messageEdit';
import { getContext, isAiStoryMessage, type STMessage } from '@/st/context';
import {
  hasImageTagTrace,
  parseImageTags,
  replaceImageTagAt,
  serializeImageTag,
  stripImageTags,
} from '@/st/imageTagRegex';
import { getTagGenChain, isCurrentChatExcluded, settings, type TagGenTarget } from '@/state/settings';

const processed = new Set<string>();
const running = new Map<string, AbortController>();
let bound = false;
const scheduled = new Set<ReturnType<typeof setTimeout>>();
const DIAGNOSTIC_PREFIX = '[BBI][AutoTagDebug]';

function diagnostic(event: string, payload: unknown = null): void {
  const seen = new WeakSet<object>();
  let detail: string;
  try {
    const json = JSON.stringify(payload, (_key, value: unknown) => {
      if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
      if (typeof value === 'bigint') return String(value);
      if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
      if (value && typeof value === 'object') {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    });
    detail = json ?? String(payload);
  } catch (error) {
    detail = JSON.stringify({ stringifyError: error instanceof Error ? error.message : String(error) });
  }
  console.info(`${DIAGNOSTIC_PREFIX} ${event} ${detail}`);
}

/**
 * 放弃本次运行并交代原因:诊断日志照旧记全量,**手动路径必须同时给 toast**。
 *
 * 手动点击是显式意图,静默 return 在用户那里就等于「按钮点了没反应」——查不出、
 * 也没法反馈。自动路径保持安静(每层楼都弹一次没人受得了),它的去向看诊断日志。
 */
function abort(
  floor: number,
  reason: string,
  manual: boolean | undefined,
  hint: string,
  payload: Record<string, unknown> = {},
): void {
  diagnostic('runForFloor:skip', { floor, reason, ...payload });
  if (manual) toastr.warning(hint, '柏宝绘');
}

function activeSwipeId(message: STMessage): number | null {
  if (!Array.isArray(message.swipes)) return null;
  return typeof message.swipe_id === 'number' ? message.swipe_id : 0;
}

function textHash(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

interface RunOptions {
  /** 手动触发(楼层按钮):绕过 autoTag.enabled 与 processed 去重;空结果也给出反馈。 */
  manual?: boolean;
  /** 重新生成:先把已有 tag 从正文剔除再分析/注入;旧图片保留在卡片历史里。 */
  replace?: boolean;
  /**
   * 单槽位提示词重写(编辑弹窗「AI 重写提示词」):只替换该 seq 的 tag,其余 tag 与图片一字不动。
   * **画面不变**——写回按 seq 原位替换,模型返回的 position 压根不参与写回,措辞口径见
   * slotPlan.buildSlotTaskNote。分析基底同样剔除全部旧 tag,但强制输出恰好 1 张,
   * 且忽略本次 AI 的 changes(首次全量分析已为整楼建过档)。
   */
  slot?: { seq: number };
}

/** 放弃写入的用户可读原因。文本变化已不在其中——那是正常情况,会 rebase 后照常写入。 */
const ABANDON_REASON: Partial<Record<ApplyMessageResult, string>> = {
  'chat-changed': '已切换聊天，本次没有写入生图 tag',
  'floor-changed': '该楼层已被删除或替换，本次没有写入生图 tag',
  'swipe-changed': '已切换 swipe，本次没有写入生图 tag',
  'build-failed': '楼层正文已被大幅改写或已存在生图 tag，本次没有写入',
  unavailable: '当前聊天不可写入，本次没有写入生图 tag',
};

/** 重定位结果的一行摘要;全部原位命中时返回空串(无需记日志)。 */
function describeRebase(report: RebaseReport): string {
  if (!report.remapped && !report.drifted) return '';
  const parts = [`原位 ${report.anchored}`];
  if (report.remapped) parts.push(`跟随改写句 ${report.remapped}`);
  if (report.drifted) parts.push(`顺延到上一段 ${report.drifted}`);
  return parts.join(' · ');
}

/** 把 AI 报告的 changes 转成当前楼层操作;真正写回在正文 CAS 成功时一次完成。 */
function planChangeOps(plan: ImagePlan): PositionedCharOp[] {
  const ops: PositionedCharOp[] = [];
  for (const change of plan.changes) {
    let op: CharTagAutoOp | null = null;
    if (change.field === 'new') {
      // value 可能是结构化字段的 JSON 串(protocol.ts 拼),也可能是整串 tag 文本
      let fields: Partial<Record<CharTagField, string>> | null = null;
      let value = '';
      if (change.value.startsWith('{')) {
        try {
          const parsed = JSON.parse(change.value) as Record<string, unknown>;
          const picked: Partial<Record<CharTagField, string>> = {};
          for (const field of CHAR_TAG_FIELDS) {
            const value = parsed[field];
            if (typeof value === 'string' && value.trim()) picked[field] = value.trim();
          }
          if (Object.keys(picked).length) fields = picked;
        } catch {
          /* 非 JSON → 当整串处理 */
        }
      }
      if (!fields && change.value) value = change.value;
      op = createCharTagNewOp(
        {
          name: change.name,
          fields: { ...emptyCharFields(), ...(fields ?? {}) },
          raw: value,
          nl: change.nl ?? '',
          source: 'ai',
          desc: '',
        },
        change.reason,
      );
    } else if (change.field === 'nl') {
      op = createCharTagSetOp(change.name, 'nl', change.value || change.nl || '', change.reason);
    } else {
      op = createCharTagSetOp(change.name, change.field, change.value, change.reason);
    }
    if (op) ops.push({ op, sourceLine: change.sourceLine });
  }
  return ops.sort((left, right) => left.sourceLine - right.sourceLine);
}

/* ============ 请求策略:渠道链 × 每渠道重试 ============ */

/** 一次待发请求。 */
interface PlanAttempt {
  target: TagGenTarget;
  /** 目标在渠道链里的序号,0 = 主渠道;> 0 即已切到备用。 */
  index: number;
  /** 本渠道内的第几轮(1-based)。 */
  round: number;
  /** 本渠道总轮数(= retryCount + 1)。 */
  rounds: number;
}

/**
 * 把「渠道链 × 每渠道 retries+1 轮」摊平成一串请求计划。
 *
 * 摊平而不写嵌套双循环:执行侧只剩单层循环,中止判断与提示更新各写一次;
 * 「备用渠道拿几次机会」这条策略也就集中在这一个纯函数里,而不是散在循环条件上。
 * 未配备用渠道时产出与旧版逐次一致(retries+1 条),存量行为不变。
 */
function planAttempts(chain: TagGenTarget[], retries: number): PlanAttempt[] {
  const rounds = retries + 1;
  const plans: PlanAttempt[] = [];
  for (const [index, target] of chain.entries()) {
    for (let round = 1; round <= rounds; round += 1) plans.push({ target, index, round, rounds });
  }
  return plans;
}

/** 进度提示与 console 共用的一行说明。 */
function describeAttempt(attempt: PlanAttempt): string {
  const name = `「${attempt.target.label}」`;
  if (attempt.round === 1) return attempt.index > 0 ? `已切备用${name}` : `正在请求${name}`;
  const retry = `重试 ${attempt.round - 1}/${attempt.rounds - 1}`;
  return `${attempt.index > 0 ? '备用' : ''}${retry}${name}`;
}

/** 一次请求的作用范围:整楼,或楼里的第 seq 张(单槽重写)。 */
interface PlanScope {
  floor: number;
  /** 单槽重写的槽位(0-based);整楼为 null。 */
  slotSeq: number | null;
  /** 请求历史页的用途标签;缺省 = 自动 tag(存量行为)。 */
  chain?: 'worldbook';
}

/**
 * 请求历史页的用途标签。整楼且无重试无备用时与旧版**逐字一致**——历史页不会凭空变样;
 * 单槽重写标成「重写提示词(第 N 楼 · 第 M 张 …)」,一眼看出不是整楼分析。
 */
function describeSource(scope: PlanScope, attempt: PlanAttempt): string {
  const parts: string[] = [];
  if (scope.slotSeq !== null) parts.push(`第 ${scope.slotSeq + 1} 张`);
  if (attempt.index > 0) parts.push(`备用「${attempt.target.label}」`);
  if (attempt.rounds > 1) parts.push(`第 ${attempt.round} 次`);
  const head =
    scope.slotSeq !== null ? '重写提示词' : scope.chain === 'worldbook' ? '世界书链' : '自动 tag';
  return parts.length ? `${head}(第 ${scope.floor} 楼 · ${parts.join(' ')})` : `${head}(第 ${scope.floor} 楼)`;
}

/** 跑一次请求。返回非空 = 验收通过;抛错交给调用方计入 lastError。 */
async function requestPlanOnce(
  target: TagGenTarget,
  messages: ChatMsg[],
  parse: (raw: string) => ImagePlan,
  signal: AbortSignal,
  source: string,
): Promise<ImagePlan | null> {
  // parsed 用对象壳装着:validate 闭包写入,await 之后读取——请求成功 + 验收通过才非空。
  // (直接 let 会被 TS 收窄成 null:闭包内的赋值控制流分析看不见。)
  const parsed: { plan: ImagePlan | null } = { plan: null };
  const opts = { signal, source, validate: (raw: string) => void (parsed.plan = parse(raw)) };
  if (target.channel) await requestCompletion(target.channel, messages, opts);
  else await requestViaMainApi(messages, opts);
  return parsed.plan;
}

interface PlanRequestResult {
  plan: ImagePlan | null;
  /** 最后一次失败的错误文本。 */
  lastError: string;
  /** 中止信号已触发:调用方按「取消」处理(删 processed、静默返回)。 */
  aborted: boolean;
  /** 实际用过的渠道数(> 1 = 切过备用),用于失败文案。 */
  targetsTried: number;
  /** 每个渠道的总轮数(= retryCount + 1)。 */
  rounds: number;
}

/**
 * 按渠道链依次请求,直到拿到通过验收的 plan。
 *
 * 可重试的异常有两类,都在这里吞掉并继续:请求本身失败(网络/HTTP/超时),
 * 以及「返回了但协议解析/校验不通过」——后者常见于模型没遵守协议。
 * 中止信号立即收手,不消耗剩余轮次。
 */
async function requestImagePlan(
  scope: PlanScope,
  messages: ChatMsg[],
  parse: (raw: string) => ImagePlan,
  signal: AbortSignal,
  notice: TagNoticeHandle,
): Promise<PlanRequestResult> {
  const floor = scope.floor;
  const retries = Math.max(0, Math.floor(Number(settings.autoTag.retryCount) || 0));
  const result: PlanRequestResult = {
    plan: null,
    lastError: '',
    aborted: false,
    targetsTried: 1,
    rounds: retries + 1,
  };
  for (const attempt of planAttempts(getTagGenChain(), retries)) {
    if (signal.aborted) return { ...result, aborted: true };
    result.targetsTried = attempt.index + 1;
    const detail = describeAttempt(attempt);
    notice.update(detail);
    try {
      const source = describeSource(scope, attempt);
      const plan = await requestPlanOnce(attempt.target, messages, parse, signal, source);
      if (signal.aborted) return { ...result, aborted: true };
      if (plan) return { ...result, plan };
    } catch (error) {
      if (signal.aborted) return { ...result, aborted: true };
      result.lastError = error instanceof Error ? error.message : String(error);
      console.warn(`[柏宝绘] 第 ${floor} 楼 ${detail} 生成 tag 失败`, error);
    }
  }
  return result;
}

/** 全部打光后失败 toast 的括号后缀。无重试无备用时为空串(与旧版逐字一致)。 */
function describeExhausted(result: PlanRequestResult): string {
  const retries = result.rounds - 1;
  if (result.targetsTried > 1) {
    return retries > 0
      ? `(主渠道与备用渠道各试 ${result.rounds} 次均失败)`
      : '(主渠道与备用渠道都失败了)';
  }
  return retries > 0 ? `(已自动重试 ${retries} 次)` : '';
}

/**
 * 按开跑时的协议形态收尾:协议没要 nl 时丢掉模型照写的 nl(留着就会照常发送,开关等于没关);
 * 渠道锁了方向则统一改记锁定值——出图本就按锁走,这里只是让 tag 里记的方向与实际画幅一致。
 */
function trimToProfile(plan: ImagePlan, profile: AutoTagProfile): void {
  for (const image of plan.images) {
    if (!profile.nl) image.nl = '';
    if (!profile.characterNl) for (const character of image.characters) character.nl = '';
    // square 只有允许方形的渠道才保留;其它渠道模型照写了也改回竖屏(出图端本就按竖屏出)
    if (image.size === 'square' && !profile.squareSize) image.size = 'portrait';
    if (profile.lockedSize) image.size = profile.lockedSize;
  }
}

/** 撤销本次挂上的出图标记。单槽只撤自己那一枚:clearAutoGenerateForFloor 会连累同楼其它槽位。 */
function unmarkPlan(chatId: string, floor: number, swipeId: number, slot: RunOptions['slot']): void {
  if (slot) consumeAutoGenerate(chatId, floor, swipeId, slot.seq);
  else clearAutoGenerateForFloor(chatId, floor);
}

/** 世界书生图按当前出图渠道定形:有分角色提示的保留角色,ComfyUI / ImgRouter 拼成一串。 */
function worldbookTarget(): 'characters' | 'folded' {
  const backend = settings.defaultBackend;
  return backend === 'nai' || backend === 'latent' || backend === 'latentapi' ? 'characters' : 'folded';
}

/**
 * 世界书生图:正文里已有 `image###…###` 时原位换成 <bbi_image> 并出图,不请求副 API。
 * 返回 true = 本楼已由这条路处理完(转成了、或格式不符已提示),调用方不再走副 API。
 *
 * 读到生图词就一律 force 出图,不看「写入 tag 后自动生成图片」开关:世界书生图的意义就是出图。
 */
async function runWorldbookImages(floor: number, message: STMessage, chatId: string, manual: boolean): Promise<boolean> {
  if (!hasWorldbookImage(message.mes)) return false;
  const format = settings.autoTag.worldbookFormat;
  const target = worldbookTarget();
  const preview = convertWorldbookImages(message.mes, format, target);
  if (!preview.converted) {
    // 有块但一个都读不出 = 格式选错了。不回落副 API:那是另一套提示词,结果不会是用户想要的
    toastr.warning(`第 ${floor} 楼的生图词格式与「世界书格式」设置（${format === 'nai' ? 'NAI' : 'Anima'}）不符，没有转换`, '柏宝绘');
    return true;
  }
  const swipeId = activeSwipeId(message);
  const markSwipeId = message.swipe_id ?? 0;
  for (let seq = 0; seq < preview.converted; seq++) markForAutoGenerate(chatId, floor, markSwipeId, seq, 'force');
  const result = await applyMessageText(
    floor,
    currentText => {
      // 写回以落盘那一刻的正文为准;期间别处已贴过 tag 或块数变了,宁可放弃也不错位
      if (hasImageTagTrace(currentText)) return null;
      const next = convertWorldbookImages(currentText, format, target);
      return next.converted === preview.converted ? next.text : null;
    },
    chatId,
    swipeId,
    message,
  );
  if (result === 'saved') {
    const skippedNote = preview.skipped ? `，${preview.skipped} 段格式不符保留原文` : '';
    toastr.success(`已从世界书生图词生成 ${preview.converted} 张图片的提示词${skippedNote}`, '柏宝绘');
    return true;
  }
  clearAutoGenerateForFloor(chatId, floor);
  console.info(`[柏宝绘] 第 ${floor} 楼世界书生图放弃写入：${result}`);
  if (manual || result !== 'build-failed') toastr.warning(ABANDON_REASON[result] ?? '本次没有写入生图 tag', '柏宝绘');
  return true;
}

async function runForFloor(floor: number, opts: RunOptions = {}): Promise<void> {
  const context = getContext();
  diagnostic('runForFloor:enter', {
    floor,
    manual: Boolean(opts.manual),
    replace: Boolean(opts.replace),
    chatId: context?.getCurrentChatId?.() ?? '',
    extensionEnabled: settings.enabled,
    autoTagEnabled: settings.autoTag.enabled,
  });
  if (!context) {
    abort(floor, 'missing-context', opts.manual, 'SillyTavern 还没就绪，请稍后重试');
    return;
  }
  if (!settings.enabled) {
    abort(floor, 'extension-disabled', opts.manual, '柏宝绘已停用，请先在插件设置里开启');
    return;
  }
  // 世界书生图/世界书链开着时,自动路径由对应分支接管(与「自动生成 tag」开关无关),这里先放行
  const worldbookOn = settings.autoTag.worldbookImages;
  const chainBook = activeWorldbook(settings.worldbookChain);
  const chainOn = chainBook !== null;
  if (!opts.manual && !settings.autoTag.enabled && !worldbookOn && !chainOn) {
    diagnostic('runForFloor:skip', { floor, reason: 'auto-tag-disabled' });
    return;
  }
  // 排除角色闸门(与柏宝书同名单):该角色名所在聊天的自动 tag 全流程停用,
  // 手动按钮也在 actionButton 层撤掉,这里做兜底(手动触发时给反馈)。
  if (isCurrentChatExcluded()) {
    abort(floor, 'chat-excluded', opts.manual, '该角色已被排除，不生成生图 tag');
    return;
  }
  const message = context.chat[floor];
  const messageDiagnostic = message
    ? {
        isUser: message.is_user,
        isSystem: message.is_system,
        textLength: typeof message.mes === 'string' ? message.mes.length : -1,
        extraType: message.extra?.type ?? null,
      }
    : null;
  // 与楼层按钮同一个谓词(st/context.ts):被 /hide 隐藏的普通楼算剧情楼,照样能跑
  if (!isAiStoryMessage(message)) {
    abort(floor, 'not-ai-story-message', opts.manual, '这一楼不是可插图的剧情楼层（用户楼 / ST 系统楼）', {
      message: messageDiagnostic,
    });
    return;
  }
  const rawSource = message.mes;
  const slot = opts.slot;
  // 单槽重写的目标:开跑时快照第 seq 条 tag 的原文,写回前用它确认 seq 指的还是同一条
  // (同提示词编辑弹窗的纪律)。正文这会儿已经没这条 tag = 期间被删/换 swipe,直接放弃。
  const slotRawTag = slot ? parseImageTags(rawSource)[slot.seq] : undefined;
  if (slot && slotRawTag === undefined) {
    abort(floor, 'slot-missing', true, `第 ${slot.seq + 1} 张图片的提示词已不存在（可能已换 swipe 或被编辑），本次没有重写`);
    return;
  }
  // 探测口径与按钮层同源(imageTagRegex.hasImageTagTrace):两侧漂移过一次——
  // 按钮只认开标签、这里认开也认闭,只剩 `</bbi_image>` 的楼就卡成「点了没反应」。
  // 单槽重写以「本楼已有 tag」为前提,不受此闸门拦截。
  if (hasImageTagTrace(rawSource) && !opts.replace && !slot) {
    abort(
      floor,
      'already-has-image-tag',
      opts.manual,
      '本楼已有生图 tag，没有确认重新生成，本次未改动',
    );
    if (!opts.manual) console.debug(`[柏宝绘] 第 ${floor} 楼已经含有 bbi_image tag，跳过自动分析`);
    return;
  }
  // 世界书生图:有生图词就直接转换出图,不请求副 API;开着却没有生图词时,自动路径什么都不做
  // (省请求正是这个开关的目的),手动按钮则照旧走副 API。重新生成(replace)与单槽重写不走这条。
  // 世界书链开着时由它接管,旧的「世界书生图」整条让位。
  if (!chainOn && worldbookOn && !opts.replace && !slot) {
    const currentChatId = context.getCurrentChatId?.() ?? '';
    if (currentChatId && (await runWorldbookImages(floor, message, currentChatId, Boolean(opts.manual)))) return;
    if (!opts.manual) {
      diagnostic('runForFloor:skip', { floor, reason: 'worldbook-no-image-block' });
      return;
    }
  }
  // replace / slot:分析都基于剔除旧 tag 后的正文。写回时 replace 让旧 tag 随之消失,
  // slot 按 seq 原位替换——别的 tag 在写回基底里原样保留。
  const source = opts.replace || slot ? stripImageTags(rawSource) : rawSource;
  if (!source.trim()) {
    abort(floor, 'empty-source', opts.manual, '本楼正文是空的（或只剩生图 tag），没有可分析的内容');
    return;
  }
  const preparedTarget = prepareTargetText(source, settings.excludes.customStripTags);
  if (!preparedTarget.segments.length) {
    abort(
      floor,
      'no-target-segments',
      opts.manual,
      '本楼正文清洗后没剩下叙事内容（可能被「剔除标签」名单或思维链/注释规则全删了），没有可分析的段落',
      { sourceLength: source.length },
    );
    return;
  }

  const chatId = context.getCurrentChatId?.() ?? '';
  if (!chatId) {
    abort(floor, 'missing-chat-id', opts.manual, '当前没有打开的聊天，本次没有生成生图 tag');
    return;
  }
  const swipeId = activeSwipeId(message);
  const identity = `${chatId}\u0000${floor}\u0000${swipeId ?? 'none'}\u0000${textHash(source)}`;
  // 手动是显式意图:即使同一正文自动流程已处理过(比如结论是无需插图)也照跑,
  // 但仍写入 processed,防止自动流程随后对同一正文重复请求。
  if (!opts.manual && processed.has(identity)) {
    diagnostic('runForFloor:skip', { floor, reason: 'already-processed', chatId, swipeId, identity });
    return;
  }
  processed.add(identity);
  diagnostic('runForFloor:start', {
    floor,
    chatId,
    swipeId,
    identity,
    sourceLength: source.length,
    segmentCount: preparedTarget.segments.length,
  });

  const runKey = `${chatId}\u0000${floor}`;
  running.get(runKey)?.abort();
  const controller = new AbortController();
  running.set(runKey, controller);

  // 提示开在闸门全过之后、拼提示词之前:世界书扫描也要时间,不能等到发请求才提示。
  // 声明在 try 之外,finally 才收得干净(任何路径退出都撤掉这一段)。
  const noticeText = slot
    ? `重写第 ${slot.seq + 1} 张 · 准备提示词…`
    : chainOn
      ? '世界书链 · 准备提示词…'
      : '准备提示词…';
  const notice = beginTagNotice(floor, noticeText);
  const markSwipeId = message.swipe_id ?? 0;

  try {
    const memory = readBookMemory(floor, context.chat[floor]?.mes ?? '', context.name1);
    // 单槽重写:库文本要包含本楼已落档的增量(首次全量分析建的档),否则 AI 会把
    // 已建档角色当新人重写。charTagsBeforeFloor(floor + 1) 正好含本楼(swipe 匹配时生效)。
    const entriesBefore = slot ? charTagsBeforeFloor(floor + 1) : charTagsBeforeFloor(floor);
    // 锁定名(全局库 ⊖ 本聊天基线):AI 的 changes 对这些名字一律无效,库文本里带 [locked] 标记
    const lockedNames = lockedCharTagNames();
    // 纯本地渲染:建档由主请求在同一次输出里完成(changes 的 field="new")
    const anchors = resolveCharAnchors(entriesBefore, lockedNames);
    // 单槽重写:协议强制「恰好 1 张」。min/max 要同时覆盖 build 的规则文案与下面的 parse 校验
    const promptOptions = slot ? { ...settings.autoTag, minImages: 1, maxImages: 1 } : settings.autoTag;
    // 协议形态开跑时快照一次:写协议、验收与收尾同一份,用户中途拨开关也不会前后不一
    const profile = autoTagProfile();
    const messages: ChatMsg[] =
      chainBook && !slot
        ? buildWorldbookChainMessages(
            context,
            floor,
            chainBook,
            {
              contextMessages: settings.autoTag.contextMessages,
              enforceTagLimit: settings.worldbookChain.enforceTagLimit,
              tagLimitChars: settings.worldbookChain.tagLimitChars,
            },
            preparedTarget,
            anchors.text,
          )
        : await buildAutoTagMessages(
            context,
            floor,
            promptOptions,
            memory,
            preparedTarget,
            anchors.text,
            slot ? buildSlotTaskNote(rawSource, slot.seq) : '',
            profile,
          );
    // 解析/校验放进 parse 回调:不过则请求历史如实记为失败(而非「HTTP 拿到文本」的
    // 绿色成功),错误原样抛回 requestImagePlan 走下一轮——显示与行为同口径。
    // parseImagePlan 对坏输出抛错,「无画面」则是正常返回空数组。
    const parse = (raw: string): ImagePlan => {
      if (chainBook && !slot) {
        return parseWorldbookChainPlan(raw, preparedTarget.segments, {
          maxImages: settings.worldbookChain.maxImages,
          enforceTagLimit: settings.worldbookChain.enforceTagLimit,
          tagLimitChars: settings.worldbookChain.tagLimitChars,
        });
      }
      const candidate = parseImagePlan(raw, preparedTarget.segments, promptOptions.minImages, promptOptions.maxImages);
      // 角色项写 nl 的协议(NAI 系 4.5/V5 且开着自然语言)才要求建档带 nl;单槽重写忽略本次
      // changes,不校验——为一份会被丢弃的 changes 白耗重试次数不值。
      if (
        !slot &&
        profile.characterNl &&
        candidate.changes.some(change => change.field === 'new' && !change.nl?.trim())
      ) {
        throw new Error('NAI 4.5/V5 建档必须附带 nl 外貌描述');
      }
      return candidate;
    };
    const scope: PlanScope = {
      floor,
      slotSeq: slot ? slot.seq : null,
      chain: chainBook && !slot ? 'worldbook' : undefined,
    };
    const attempted = await requestImagePlan(scope, messages, parse, controller.signal, notice);
    if (attempted.aborted) {
      processed.delete(identity);
      return;
    }
    if (!attempted.plan) {
      // 所有渠道所有轮次打光:允许同一正文在后续重新渲染后再试
      processed.delete(identity);
      toastr.error(`${attempted.lastError}${describeExhausted(attempted)}`, '柏宝绘自动 tag 失败');
      return;
    }
    const plan = attempted.plan;
    trimToProfile(plan, profile);

    // 单槽重写不落 changes:首次全量分析已为整楼建过档,这里再应用一次只会产生
    // 重复的建档/变更记录;库文本已含本楼增量(见上面 entriesBefore),AI 照抄即可。
    const planOps = slot ? [] : planChangeOps(plan);
    // 锁定角色(全局库)不接受 AI changes:丢弃,不写入楼层、不参与 @替换。
    // 重放侧 applyCharTagOps 也会按锁定名再拦一次(旧消息里可能已存这类 ops)。
    const effectiveOps = lockedNames.size
      ? planOps.filter(item => !lockedNames.has(item.op.name))
      : planOps;
    const floorOps = effectiveOps.map(item => item.op);
    const previousDelta = readCharTagFloorDelta(message);

    // @占位符按正文位置替换：变化前图片用旧档，变化位置及之后用新档。
    const unknownNames = new Set<string>();
    for (const image of plan.images) {
      const tagRes = applyPositionedCharRefs(
        image.tag,
        anchors.entries,
        effectiveOps,
        image.sourceLine,
        'tag',
        lockedNames,
      );
      if (tagRes.text) image.tag = tagRes.text;
      if (image.nl) {
        const nlRes = applyPositionedCharRefs(
          image.nl,
          anchors.entries,
          effectiveOps,
          image.sourceLine,
          'nl',
          lockedNames,
        );
        image.nl = nlRes.text;
        for (const n of nlRes.unknown) unknownNames.add(n);
      }
      for (const character of image.characters) {
        const charTag = applyPositionedCharRefs(
          character.tag,
          anchors.entries,
          effectiveOps,
          image.sourceLine,
          'tag',
          lockedNames,
        );
        character.tag = charTag.text;
        for (const n of charTag.unknown) unknownNames.add(n);
        if (character.nl) {
          const charNl = applyPositionedCharRefs(
            character.nl,
            anchors.entries,
            effectiveOps,
            image.sourceLine,
            'nl',
            lockedNames,
          );
          character.nl = charNl.text;
          for (const n of charNl.unknown) unknownNames.add(n);
        }
      }
      for (const n of tagRes.unknown) unknownNames.add(n);
    }
    if (unknownNames.size) {
      // 模型认为这是角色、却没给它建档 —— 该角色在图里将完全没有外貌。
      // 这是漏建档唯一的确定性信号,藏进控制台等于没有,必须让用户看见。
      const names = [...unknownNames].join('、');
      console.warn('[柏宝绘] AI 引用了库里没有的角色占位符,已剥除:', names);
      toastr.warning(`角色「${names}」没有建档，本次画面中缺少其外貌`, '柏宝绘');
    }

    // 单槽重写没给出新提示词:保留原提示词与原图,不替换(空 images 不是错误)。
    if (slot && !plan.images.length) {
      toastr.info('模型没有给出新的提示词，本张保持原样', '柏宝绘');
      return;
    }
    // 没有图片、没有角色变化、也没有旧楼层变化要清理时,保持原来的无写入早退。
    if (!plan.images.length && !floorOps.length && !previousDelta) {
      if (opts.manual) toastr.info('模型认为本楼没有值得插图的画面', '柏宝绘');
      else console.debug(`[柏宝绘] 第 ${floor} 楼无需插图`);
      return;
    }

    // 触发 MESSAGE_EDITED / MESSAGE_UPDATED,卡片水合挂载时消费标记并自动开始生成
    // (见 floor/autoGenerate.ts);写回失败则撤销标记。
    // 单槽重写是用户在卡片上的显式意图(同编辑弹窗的「应用并重新生成」),不受 autoGenerate 开关约束。
    const marked = plan.images.length > 0 && (settings.autoTag.autoGenerate || !!slot);
    if (marked && slot) markForAutoGenerate(chatId, floor, markSwipeId, slot.seq, 'force');
    else if (marked) {
      for (let seq = 0; seq < plan.images.length; seq++) markForAutoGenerate(chatId, floor, markSwipeId, seq);
    }
    // 正文在 buildNext 里基于「落盘那一刻的真实正文」现算:分析期间别的插件对正文的修改
    // (翻译/润色/追加状态栏/改写句子)全部保留,tag 按叙事行重新定位后照常注入。
    let rebaseNote = '';
    const result = await applyMessageText(
      floor,
      currentText => {
        // 单槽重写:只替换第 seq 条 tag,正文与其它 tag 一字不动,也不需要位置重定位。
        // 模型返回的 position 在这里刻意不参与——画面钉死在原位,它只负责重写内容。
        // 开跑时快照的原文对不上 = 期间被用户/别的流程改过,放弃覆盖(同提示词编辑弹窗)。
        if (slot) {
          if (parseImageTags(currentText)[slot.seq] !== slotRawTag) return null;
          return replaceImageTagAt(currentText, slot.seq, serializeImageTag(plan.images[0]));
        }
        // replace 路径同样以当前正文为基底剔除旧 tag,不能用旧快照
        const base = opts.replace ? stripImageTags(currentText) : currentText;
        if (!plan.images.length) return base;
        // 请求期间用户/别的插件已经贴过 tag:再注入就是重复,交回 build-failed 走放弃分支
        if (!opts.replace && hasImageTagTrace(currentText)) return null;
        const rebased = rebaseImagePositions(
          base,
          preparedTarget.segments,
          plan.images,
          settings.excludes.customStripTags,
        );
        if (!rebased) return null;
        rebaseNote = describeRebase(rebased.report);
        return injectImageTags(base, rebased.images);
      },
      chatId,
      swipeId,
      message,
      // 单槽不写 extra:本楼角色增量与其它槽位图片都不归它管,不传 extraUpdate 即保持原样
      slot ? undefined : { key: BBI_CHAR_EXTRA_KEY, value: makeCharTagFloorDelta(floorOps, swipeId ?? 0) },
    );
    if (result === 'saved' && slot) {
      toastr.success(`已重写第 ${slot.seq + 1} 张的提示词，正在按新提示词出图`, '柏宝绘');
      return;
    }
    if (result === 'saved') {
      recomputeCharTags();
      if (rebaseNote) console.info(`[柏宝绘] 第 ${floor} 楼 tag 位置重定位:${rebaseNote}`);
      if (plan.images.length) {
        toastr.success(`已在第 ${floor} 楼插入 ${plan.images.length} 个生图 tag`, '柏宝绘');
      } else if (opts.manual) {
        toastr.info('模型认为本楼没有值得插图的画面', '柏宝绘');
      } else {
        console.debug(`[柏宝绘] 第 ${floor} 楼无需插图`);
      }
      return;
    }
    if (marked) unmarkPlan(chatId, floor, markSwipeId, slot);
    console.info(`[柏宝绘] 第 ${floor} 楼放弃写入生图 tag：${result}`);
    // 单槽重写的放弃原因与全量不同:正文其它部分改没改不重要,关键是这一条 tag 被改过
    if (slot && result === 'build-failed') {
      toastr.warning('这张图的提示词在生成期间已被改动，本次没有覆盖它', '柏宝绘');
    } else {
      toastr.warning(ABANDON_REASON[result] ?? '本次没有写入生图 tag', '柏宝绘');
    }
  } catch (error) {
    // 请求失败或被切换聊天取消时允许同一正文在后续重新渲染后重试。
    processed.delete(identity);
    // 异常发生在挂标记之后时(如保存失败回滚),撤销本次标记,不留残留
    unmarkPlan(chatId, floor, markSwipeId, slot);
    if (controller.signal.aborted) return;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[柏宝绘] 第 ${floor} 楼自动生成 tag 失败`, error);
    toastr.error(message, '柏宝绘自动 tag 失败');
  } finally {
    notice.done();
    if (running.get(runKey) === controller) running.delete(runKey);
  }
}

function cancelAll(): void {
  diagnostic('cancelAll', { scheduled: scheduled.size, running: running.size });
  clearGeneration();
  // 提示必须跟着走:切聊天后留一条「正在生成」挂在新聊天上会误导人
  clearTagNotices();
  for (const timer of scheduled) clearTimeout(timer);
  scheduled.clear();
  for (const controller of running.values()) controller.abort();
  running.clear();
}

function scheduleForGeneratedFloor(floor: number, chatId: string): void {
  diagnostic('schedule', { floor, chatId });
  const timer = setTimeout(() => {
    scheduled.delete(timer);
    const currentChatId = getContext()?.getCurrentChatId?.() ?? '';
    diagnostic('schedule:fire', { floor, chatId, currentChatId, sameChat: currentChatId === chatId });
    if (currentChatId !== chatId) return;
    void runForFloor(floor);
  }, 0);
  scheduled.add(timer);
}

/**
 * 楼层按钮的手动入口。replace=true 用于「已有 tag 重新生成」:
 * 剔除旧 tag → 分析 → 写回新 tag(旧 tag 随写回消失,旧图留在卡片历史)。
 */
export async function requestFloorTags(floor: number, opts: { replace?: boolean } = {}): Promise<void> {
  await runForFloor(floor, { manual: true, replace: opts.replace });
}

/**
 * 「AI 重写提示词」的手动入口:只重写并替换第 seq 条 tag(0-based)。
 *
 * 入口在提示词编辑弹窗里(floor/promptEditor.ts)——手改与 AI 改是同一件事的两种手段。
 * 调用方把本函数交给 floor/tagPlanState.ts 的 runTagPlan 托管:请求的生命周期归那个
 * store,**关掉弹窗不中断重写**。请求与整楼分析一样走渠道链(主渠道 → 备用渠道)与进度提示。
 *
 * 画的仍是原来那个瞬间:写回按 seq 原位替换,模型返回的 position 不参与,措辞口径见
 * slotPlan.buildSlotTaskNote(把该槽位当前提示词喂回去当锚点)。本楼其它 tag 与图片一字不动,
 * 旧图留在该槽位历史里;本次 AI 输出的 changes 一律忽略(首次全量分析时已建档)。
 */
export async function requestSlotTag(floor: number, seq: number): Promise<void> {
  await runForFloor(floor, { manual: true, slot: { seq } });
}

/** 中止某楼在途的 tag 请求(全量分析与单槽重写共用同一把「每楼一把」的锁)。 */
export function cancelFloorTags(floor: number): void {
  const chatId = getContext()?.getCurrentChatId?.() ?? '';
  running.get(`${chatId}\u0000${floor}`)?.abort();
}

/** Only pair automatic tagging with the final render of a real ST generation. */
export function bindAutoTagging(): void {
  if (bound) {
    diagnostic('bind:skip', { reason: 'already-bound' });
    return;
  }
  const context = getContext();
  const events = context?.eventTypes;
  if (!context?.eventSource || !events?.GENERATION_STARTED || !events.CHARACTER_MESSAGE_RENDERED) {
    diagnostic('bind:skip', {
      reason: 'missing-events',
      hasContext: Boolean(context),
      hasEventSource: Boolean(context?.eventSource),
      generationStarted: events?.GENERATION_STARTED ?? null,
      characterRendered: events?.CHARACTER_MESSAGE_RENDERED ?? null,
    });
    return;
  }
  bound = true;

  diagnostic('bind', {
    generationStarted: events.GENERATION_STARTED,
    characterRendered: events.CHARACTER_MESSAGE_RENDERED,
    generationEnded: events.GENERATION_ENDED ?? null,
    generationStopped: events.GENERATION_STOPPED ?? null,
    chatChanged: events.CHAT_CHANGED,
  });
  context.eventSource.on(
    events.GENERATION_STARTED,
    (type: unknown, options: unknown, dryRun: unknown) => {
      const chatId = getContext()?.getCurrentChatId?.() ?? '';
      const eligible = Boolean(
        chatId && !dryRun && typeof type === 'string' && type !== 'quiet' && type !== 'impersonate',
      );
      diagnostic('GENERATION_STARTED', { chatId, type, dryRun, eligible, options });
      beginGeneration(chatId, type, dryRun);
    },
  );
  context.eventSource.on(events.CHARACTER_MESSAGE_RENDERED, (messageId: unknown, type: unknown) => {
    const chatId = getContext()?.getCurrentChatId?.() ?? '';
    const matched = consumeGeneration(chatId, type);
    diagnostic('CHARACTER_MESSAGE_RENDERED', { chatId, messageId, type, matched });
    if (!matched) return;
    const floor = typeof messageId === 'number' ? messageId : Number(messageId);
    if (!Number.isInteger(floor) || floor < 0) {
      diagnostic('render:skip', { chatId, messageId, type, reason: 'invalid-floor' });
      return;
    }
    // Do not block ST finalization, and pin the deferred run to the originating chat.
    scheduleForGeneratedFloor(floor, chatId);
  });
  if (events.GENERATION_ENDED) {
    context.eventSource.on(events.GENERATION_ENDED, (...args: unknown[]) => {
      // ST may emit this before the final CHARACTER_MESSAGE_RENDERED; that render consumes the gate.
      diagnostic('GENERATION_ENDED', { args, action: 'keep-pending-until-final-render' });
    });
  }
  if (events.GENERATION_STOPPED) {
    context.eventSource.on(events.GENERATION_STOPPED, (...args: unknown[]) => {
      diagnostic('GENERATION_STOPPED', { args });
      clearGeneration();
    });
  }
  context.eventSource.on(events.CHAT_CHANGED, (...args: unknown[]) => {
    diagnostic('CHAT_CHANGED', { args, currentChatId: getContext()?.getCurrentChatId?.() ?? '' });
    cancelAll();
  });
}
