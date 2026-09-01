# 新增 latent 渠道 — 实施方案

## 需求

新增可选出图渠道 `latent`，**协议完全沿用 NovelAI**（端点、鉴权、parameters、vibe、画师配方、zip 解包、限流一律不变）。
唯一差异：提示词按**请求历史那套分段格式**打包成一整串，塞进正向提示词字段。

目标串形态（只含有内容的段，段间空一行）：

```
--- 正向提示词 ---
1girl, old apartment stairwell, ...

--- 自然语言 ---
A girl is sitting alone on ...

--- 角色: 宾梦玲 ---
girl, long brown hair, brown eyes, petite, oversized white t-shirt, ...
```

## 现状调查结论

| 事实 | 影响 |
|---|---|
`NaiSettings` 有 20+ 字段，含 `vibes[]` / `artistPresets[]` | 照抄一份字段定义 = 维护灾难，必须复用类型 |
`NaiPanel.vue` 2013 行 + `NaiArtistManager.vue` 923 行，共 **74 处**硬编码 `settings.nai`，**零 props** | 照抄面板绝无可能，只能参数化 |
`fullPositivePrompt` 在 `buildNaiParameters`(v4_prompt) 与 `generateNaiImage`(顶层 input) **各调一次**，代码注释明确要求两处同源 | 打包逻辑只能落在该函数内部，不能在某个调用点加料 |
`generateNaiImage` 只有 `Card.vue` 一个调用方 | 生成侧改动面可控 |
`fullPositivePrompt`/`buildNaiParameters` 仅被 nai.ts 内部 + `nai.test.ts` 调用 | 签名可安全扩展（加可选参数，不破坏现有 570 个测试）|
`hydrate.ts:285` 闸门只 watch `settings.nai.concurrency` | latent 有自己的并发值，此处会失效，必须改成跟随当前渠道 |
`genQueue` / `naiRateLimit` 是**全局单例** | latent 与 nai 共用闸门与节奏，符合预期（都是阻塞式 POST，宁可保守）|

## 设计决策

**1. 复用 `NaiSettings` 类型，独立存储 `settings.latent`**

latent 是**另一个服务**，URL/Key 与 NAI 不同。若共用 `settings.nai`，切渠道就得来回改地址和密钥，等于没有「两条渠道」。
故 `settings.latent: NaiSettings` —— 类型复用（零字段重复），存储独立。`naiDefaults()` 加一个 `url` 参数即可派生 `latentDefaults()`，`normalizeNai` 原样复用。

**2. 参数化面板，不复制**

`NaiPanel` / `NaiArtistManager` 各加 `target?: BackendId`（默认 `'nai'`，现有用法不变），内部
`const conn = computed(() => target === 'latent' ? settings.latent : settings.nai)`，
把 74 处 `settings.nai.` 机械替换为 `conn.value.`。`testNaiConnection` 等工具函数本来就收 settings 对象，无需改。

**3. 打包标志随请求走，不做成用户开关**

flatten 是**这条渠道的定义**，不是可调项——给个开关只会让人关掉它然后困惑为何不work。
故 `NaiGenerateValues` 加 `flatten?: boolean`，由 `Card.vue` 按当前后端传入。
`fullPositivePrompt` 加可选第 4/5 参（characters、flatten），现有全部调用点与测试不受影响。

flatten 为真时：
- 正向 = 分段打包串（画师串/质量词仍并进「正向提示词」段，保持 `artist, prompt, quality` 既有次序）
- `v4_prompt.char_captions` **置空** —— 角色已在文本里，再发一遍结构化角色 = 同一角色喂两遍
- 负面**仍走 `negative_prompt` 字段**（NAI 协议有专属字段，不塞进正向）

**4. 分段格式抽成单一真源**

新建 `src/backends/promptSections.ts`：段标签常量 + `--- label ---\ntext` 拼装。
latent 与请求历史页的「复制整条」共用它——否则「与历史同格式」这条需求会随时间漂移失效。

## 改动清单

| 文件 | 改动 |
|---|---|
`src/backends/promptSections.ts` | **新建**。`SECTION_LABELS` + `buildPromptSections()` + `joinSections()` |
`src/backends/nai.ts` | `NaiGenerateValues.flatten?`；`fullPositivePrompt` 加 characters/flatten 可选参；`buildNaiParameters` flatten 时清空 char_captions；`generateNaiImage` 顶层 input 同源传参 |
`src/state/settings.ts` | `BackendId` 加 `'latent'`；`BACKENDS` 加条目；`latentDefaults()`；`ImageSettings.latent`；merge 里 `normalizeNai(r.latent, d.latent)`；`applyInto` |
`src/pages/backend/panels/NaiPanel.vue` | 加 `target` prop + `conn` 计算属性，63 处替换；「设为当前渠道」按钮写对应 id |
`src/pages/backend/panels/NaiArtistManager.vue` | 同上，11 处替换 |
`src/pages/backend/index.vue` | `PANELS.latent = NaiPanel`，用 `:target` 传当前页签 |
`src/floor/Card.vue` | `latentActive`；`configured`/`pendingHint`/`activeBackend`/`pickSeed`/`historyModel`/`runGeneration` 各加 latent 分支（复用 NAI 全部逻辑，仅多传 flatten）|
`src/floor/hydrate.ts` | 闸门改为跟随当前渠道的 concurrency |
`src/state/history.ts` | `ImageBackend` 加 `'latent'` |
`src/pages/history/index.vue` | `BACKEND_LABELS.latent = 'Latent'` |
`src/autoTag/prompt.ts` | latent 走 NAI 那套规范/思维链（`naiSupportsCharacterPrompts` 判据改读当前渠道模型）|
`src/autoTag/runner.ts` | 建档 nl 校验的 `=== 'nai'` 放宽到含 latent |

## 假设（请确认或纠正）

1. **负面提示词不打包进正向**，仍走 `negative_prompt` 字段（NAI 协议有专属字段）。
2. **latent 有自己的 vibe 库与画师配方库**，不与 NAI 共用（独立渠道 = 独立库；共用会导致改一边动两边）。
3. **模型下拉沿用 NAI 那份白名单**（`NAI_MODELS`）。若你的 latent 上游要填别的模型名，需改成自由输入框——告诉我即可。

## 验证

`vue-tsc --noEmit`（预期仅 `vite.config.ts` 7 个既有错误）→ `vitest run`（570 个须全绿）→ `vite build`。
重点回归：`nai.test.ts`（签名扩展不得改变既有行为）、`settings.*.test.ts`（迁移）。

## 风险

- 74 处机械替换：漏一处会出现「改 latent 却写进了 nai」的静默串档。替换后用 grep 断言两个面板里 `settings.nai` 归零。
- 本地无 latent 上游，端到端出图需你实测。
