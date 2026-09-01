# 生成 tag:备用渠道切换 + 生成期常驻提示

## 需求

1. **备用渠道**:副 API 生成 tag 现在只会在**同一个渠道**上把 `retryCount` 次重试打完
   (`runner.ts:279` 只取 `getTagGenChannel()` 一个渠道)。要求主渠道重试耗尽后自动
   **换另一个渠道**再重试一轮。
2. **生成期提示**:自动路径(AI 回复落地后自动跑)在写入成功之前对用户**完全静默**——
   只有 `console` 日志。用户不打开插件 UI 就无从知道插件正在生成 tag。
   要求在酒馆里能看见一条提示。

已确认的口径(用户拍板):

- 备用渠道**同样享有 `retryCount` 次重试**(与主渠道对称,口径统一)。
  `retryCount=1` 时最坏 4 次请求:主 2 次 + 备用 2 次。
- 提示做成**常驻 toast**,重试/切渠道时原地改文字,收尾自动撤掉。
- 提示**带开关,默认开**。

## 结论:改 4 个文件 + 新增 1 个 + 补 1 个测试字段

| 文件 | 改动 |
| --- | --- |
| `src/state/settings.ts` | 加 `assignments.tagGenFallback` + `ASSIGN_MAIN_API` 哨兵 + `getTagGenChain()` + `autoTag.notifyProgress`;清洗与悬空清理配套 |
| `src/autoTag/notice.ts` | **新增**:生成期常驻 toast(多楼合并成一条) |
| `src/autoTag/runner.ts` | 重试循环换成「渠道链 × 每渠道重试」摊平计划;接进度提示;失败文案带渠道信息 |
| `src/pages/settings/index.vue` | 备用渠道下拉 + 进度提示开关 + `removeChannel` 清理备用指派 |
| `src/autoTag/prompt.test.ts` | 20 处 `AutoTagSettings` 字面量补 `notifyProgress`(否则 `vue-tsc` 挂) |

`api/client.ts` **一行不改** —— 它已经是「给一个渠道,发一次请求」的纯粹形态,
渠道选择与重试策略本来就在 runner 手里。`getTagGenChannel()` 签名不动(仍是唯一的
主渠道解析器),`getTagGenChain()` 建在它上面,现有唯一调用方无需改口。

---

## 一、数据结构

### 1.1 备用渠道指派

`assignments` 从一格变两格:

```ts
/** 任务指派的渠道 id。tagGen=生成画图 tag;空串=跟随主 API。 */
assignments: {
  tagGen: string;
  /** 主渠道重试耗尽后改用的渠道。空串 = 不启用备用(保持旧行为)。 */
  tagGenFallback: string;
};
```

两格的空串含义**不同**,这是存量兼容逼出来的,必须显式记下:

| 值 | `tagGen` | `tagGenFallback` |
| --- | --- | --- |
| `''` | 跟随主 API(存量语义,不能改) | **不启用备用** |
| `ASSIGN_MAIN_API` | 不产生 | 备用 = 跟随主 API |
| `ch_xxx` | 该渠道 | 该渠道 |

```ts
/**
 * 备用渠道指派的哨兵值:备用走「跟随主 API」。
 * 不能复用空串——空串在 tagGenFallback 上已被占为「不启用备用」。
 * 渠道 id 一律 `ch_<ts>_<seq>`,与本值不可能相撞。
 */
export const ASSIGN_MAIN_API = '__main_api__';
```

### 1.2 渠道链解析

```ts
/** 一个可请求的 tag 生成目标。channel=null 表示走 requestViaMainApi。 */
export interface TagGenTarget {
  channel: ApiChannel | null;
  /** 提示与请求历史里显示的名字(跟随主 API 时为 FOLLOW_MAIN_API 同名文本)。 */
  label: string;
}

/**
 * 生成 tag 的渠道链:[主渠道, 备用渠道?]。第一项恒存在(未指派 = 跟随主 API)。
 * 备用被剔除的三种情况:未启用、指派的渠道已被删、与主渠道是同一个目标
 * (同一个渠道再打一轮换不出运气,只是白烧 token)。
 */
export function getTagGenChain(): TagGenTarget[];
```

### 1.3 提示开关

`AutoTagSettings` 加一格,紧邻 `autoGenerate`:

```ts
/** 生成 tag 期间在酒馆里弹常驻进度提示(默认开)。 */
notifyProgress: boolean;
```

放 `autoTag` 而不是 `ui`:它只影响自动 tag 这条链路,查「为什么没提示」的人会先翻
自动 tag 设置。存储位置跟功能走,不跟控件类型走。

### 1.4 清洗与悬空清理(三处,缺一处就出脏配置)

1. `normalizeSettings`(settings.ts:1742):`tagGenFallback` 非字符串 → `''`;
   老数据没这个键 → `''` → 不启用 → **存量行为逐字节不变**。
   `notifyProgress` 非布尔 → 回落默认 `true`。
2. `applySharedChannels`(settings.ts:1896):共享渠道列表变动后,
   `tagGenFallback` 指向已删渠道时清空。**哨兵值要跳过**,否则「备用=跟随主 API」
   会被当成悬空 id 抹掉。
3. `removeChannel`(settings/index.vue:275):删渠道时与 `tagGen` 同样清理。

---

## 二、`src/autoTag/notice.ts`(新增)

```ts
export interface TagNoticeHandle {
  /** 改写本楼那一段的文字(如「重试 2/2」「已切备用渠道 X」)。 */
  update(detail: string): void;
  /** 撤掉本楼那一段;最后一段撤掉时整条 toast 消失。幂等。 */
  done(): void;
}

/** 开一段进度提示。notifyProgress 关闭时返回空实现,调用方无需判开关。 */
export function beginTagNotice(floor: number, detail: string): TagNoticeHandle;

/** 撤掉所有段(切聊天 / cancelAll 时用)。 */
export function clearTagNotices(): void;
```

实现要点:

- **一条 toast,多段内容**:`Map<number, {floor, detail}>`(键是自增 id,不是楼号——
  同一楼被重开时两段不会互相踩)。渲染成单行 `第 12 楼 · 重试 2/2「中转A」`,
  多楼时 ` ｜ ` 连接。不叠一屏 toast。
- **原地改写**:`toastr.info(...)` 返回 jQuery 元素,存下来后
  `el.find('.toast-message').text(next)`。不重弹——重弹会有入场动画,像是又开了一次。
- **toastr 选项**:`{ timeOut: 0, extendedTimeOut: 0, closeButton: true,
  tapToDismiss: false, escapeHtml: true, preventDuplicates: false }`。
  `escapeHtml` 必开:渠道名是用户输入,直接塞 HTML 是注入面。
- **用户手动关掉后不复活**:下次 `render()` 发现元素已脱离文档且本批次曾经弹过 →
  只更新内存不重弹。批次归零(全部 `done()`)时复位,下一批照常弹。
- **绝不影响主流程**:所有 toastr 调用套 try/catch 静默(照 `history.ts` 的
  `safeHistory` 先例)。提示是辅助设施,它炸了不能带走 tag 生成。

---

## 三、`src/autoTag/runner.ts`

### 3.1 重试策略摊平成纯函数(这是本次改动的核心)

现在的双层需求(渠道链 × 每渠道重试)如果写成嵌套双循环,`runForFloor` 里会多两层
缩进、`aborted` 判断要重复四遍。改成**先摊平成请求计划,再单层循环执行**:

```ts
interface PlanAttempt {
  target: TagGenTarget;
  /** 本渠道内的第几轮(1-based)与总轮数,用于提示文案。 */
  round: number;
  rounds: number;
  /** 是否已切到备用渠道。 */
  fallback: boolean;
}

/** 把「渠道链 × 每渠道 retries+1 轮」摊平成一串请求计划。纯函数,可单测。 */
function planAttempts(chain: TagGenTarget[], retries: number): PlanAttempt[];
```

`retryCount=1`、配了备用渠道时产出 4 条:
`[主/1of2, 主/2of2, 备用/1of2(fallback), 备用/2of2(fallback)]`。
未配备用时产出 2 条 —— 与现在的行为**完全一致**。

### 3.2 请求执行

```ts
/** 跑一次请求。返回 plan = 成功;抛错交给调用方计入 lastError。 */
async function requestPlanOnce(
  attempt: PlanAttempt,
  messages: ChatMsg[],
  parse: (raw: string) => ImagePlan,
  signal: AbortSignal,
  source: string,
): Promise<ImagePlan | null>;

interface PlanRequestResult {
  plan: ImagePlan | null;
  /** 最后一次失败的错误文本。 */
  lastError: string;
  /** 中止信号已触发:调用方按「取消」处理(删 processed、静默返回)。 */
  aborted: boolean;
  /** 实际用过的渠道数(>1 = 切过备用),用于失败文案。 */
  targetsTried: number;
}

async function requestImagePlan(
  floor: number,
  messages: ChatMsg[],
  parse: (raw: string) => ImagePlan,
  signal: AbortSignal,
  notice: TagNoticeHandle,
): Promise<PlanRequestResult>;
```

`parse` 回调是关键的解耦点:**校验口径一个字不改**,原来 `validate` 闭包里那套
(`parseImagePlan` + NAI 4.5/V5 建档必须带 nl)整块搬进 `runForFloor` 里定义的
`parse`,`requestImagePlan` 只管「请求 → 交给 parse → 通过就返回」。
「验收不过 → 请求历史记失败」这条现有性质也因此原样保留。

顺带把 `runForFloor` 里那 60 行重试块抽走 —— 它现在是 330 行的巨型函数,抽完短一截。

### 3.3 请求历史的 `source` 文案

现在:`自动 tag(第 12 楼 · 第 2 次)`。改成带渠道:

| 情形 | source |
| --- | --- |
| 无重试无备用 | `自动 tag(第 12 楼)`(不变) |
| 只有重试 | `自动 tag(第 12 楼 · 第 2 次)`(不变) |
| 切到备用 | `自动 tag(第 12 楼 · 备用「中转B」第 1 次)` |

历史页一眼能看出「主渠道全灭、备用救回来的」,这是排查渠道质量的主要依据。

### 3.4 失败 toast 文案

```
单渠道无重试:  <错误原文>
单渠道有重试:  <错误原文>(已自动重试 1 次)                    ← 现状不变
切过备用渠道:  <错误原文>(主渠道与备用渠道各试 2 次均失败)
```

### 3.5 接进度提示

- `beginTagNotice(floor, '准备提示词…')` 放在**所有闸门通过之后、
  `buildAutoTagMessages` 之前**(世界书扫描也要时间,不能等到发请求才提示)。
  声明在 `try` 之前,`finally` 里 `notice.done()` —— 与 `running.delete(slot)` 同处,
  任何路径退出都收得干净。
- `requestImagePlan` 每轮开头 `notice.update(...)`:
  `正在请求「中转A」` → `重试 2/2「中转A」` → `已切备用「中转B」` → `备用重试 2/2「中转B」`。
- `cancelAll()` 里加 `clearTagNotices()`:切聊天时 toast 必须跟着走,
  不能留一条「正在生成」挂在新聊天上。

---

## 四、`src/pages/settings/index.vue`

**副 API 区**,「生成 tag 使用」正下方加一行:

```
生成 tag 使用      [ 中转A          ▾ ]
失败后备用渠道     [ 不使用          ▾ ]   ← 新增
```

选项:`不使用` / `跟随主 API`(值 = `ASSIGN_MAIN_API`)/ 各渠道。

hint:*主渠道把「失败自动重试次数」用完还是失败时,自动换成这个渠道再按同样次数
重试一轮。选「不使用」= 保持现在的行为。*

主备选同一个时**不过滤选项**(过滤会让下拉项跳动),而是多一行显式警告:
*备用渠道与主渠道相同,不会生效。* —— `getTagGenChain()` 那边本来就会去重,
UI 这行只是别让它变成沉默的无效配置。

**自动 tag 区**,`自动生成图片` 开关下方加:

```
生成时显示进度提示  [✓]
```

hint:*生成 tag 期间在酒馆里显示一条常驻提示(重试与切换备用渠道也会写在上面),
不用打开插件面板也能知道它在忙。*

---

## 五、下游影响与验证

### 改了签名/接口吗

- `getTagGenChannel()` **签名与语义不动**,唯一调用方 `runner.ts` 虽然改用
  `getTagGenChain()`,但那是新增函数,不是破坏性变更。
- `assignments` 类型加字段:构造点只有 `settings.ts` 的默认值与 `normalizeSettings`
  两处(已 grep 确认),`applyInto` 是整对象赋值不受影响。
- `AutoTagSettings` 加必填字段:构造点是 `settings.ts` 默认值 +
  `normalizeSettings` + `prompt.test.ts` 20 处字面量。前两处本次改,
  测试那 20 处一次 `replace_all` 补齐 —— 不补 `vue-tsc` 直接挂。

### 存量兼容

老设置没有 `tagGenFallback`(→ `''` → 不启用)也没有 `notifyProgress`
(→ 默认 `true`)。**唯一对存量用户可感知的变化是多了一条进度 toast**,
不想要可以在设置里关。请求次数、渠道选择、校验口径全部不变。

### 跨插件风险

`assignments` 与 `notifyProgress` 都存在**本插件自己**的 `baibai_image` 命名空间里,
不进共享存储(`baibai_api_channels` 只装渠道列表)。所以柏宝书那边
「逐字段重建对象会抹掉不认识的键」的老问题(见 `ApiChannel.reasoningEffort` 注释)
在这里不存在。

### 验证

```
pnpm typecheck      # vue-tsc,主要盯 AutoTagSettings / assignments 的构造点
pnpm test           # vitest,现有 60+ 测试文件必须全绿
pnpm build          # vite 产出 dist/index.js
```

`planAttempts` 是纯函数,但按项目约定(禁止主动写测试文件)**不新增测试文件**;
它的正确性由 `pnpm test` 现有覆盖 + 实机验证保证。

### 实机验证清单(需要你在酒馆里跑)

1. 不配备用渠道 → 行为与现在完全一样(重试次数、失败文案)。
2. 主渠道故意填错 key、备用渠道正常 → 提示依次出现「正在请求」→「重试」→
   「已切备用」,最终成功写入 tag;请求历史里 4 条记录、前 2 条红、第 3 条绿。
3. 主备都填错 → 失败 toast 写明「主渠道与备用渠道各试 N 次均失败」。
4. 生成中途切聊天 → 常驻 toast 立刻消失,不残留。
5. 关掉「生成时显示进度提示」→ 全程无常驻 toast,成功/失败 toast 照旧。

---

## 明确的限制

- 备用渠道**只支持一个**。要「三个渠道轮着试」得把 `tagGenFallback` 改成数组,
  UI 也要从下拉换成列表 —— 本次不做,但 `getTagGenChain()` 返回数组、
  `planAttempts()` 吃数组,届时只需改数据结构和 UI,执行层不动。
- 备用渠道**不做健康度记忆**:每次都从主渠道开始试。主渠道长期挂掉时,
  每楼都要白烧掉主渠道那 N 次请求。做「熔断/记住上次成功渠道」是另一个话题,
  涉及跨楼层状态,不塞进这次。
- 常驻 toast 的样式吃酒馆的 toastr 主题,插件不接管——
  自绘一套通知会跟酒馆本身的通知打架。
