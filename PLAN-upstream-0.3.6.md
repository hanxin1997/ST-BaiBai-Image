# 计划：合入上游 0.3.6 + Latent 原生 API 配置库 + 删除旧 latent 渠道

对照对象：`ST-BaiBai-Image-main/`（2026-11-18 拷入，`package.json` 写 0.3.6）。
我方：`0.3.3` 分支（Latent / ImgRouter / 世界书链 / 多站点 / 楼层画师串浮层）。
目标版本：**0.3.7**。

**本文件只是方案。未批准前不改 `src/`。**

---

## 0. 一句话

把上游 0.3.6 里**能用**的部分（方案库、画师串库、接入点分账、ComfyUI 三库、沉浸显示、NAI 5 Medium / V5 修正）合进来，
再加一个上游没有的 **Latent 原生 API 配置库**（多套出图参数 + 提示词 + 预览图，一键切换），
并**删除旧 latent 渠道**（NAI 协议那个，已被原生 API 取代）；
**漫画方案（MOSS-Image）本轮不做**。

---

## 1. 范围

### 做

| # | 模块 | 来源 |
|---|---|---|
| 1 | P0 修正：沉浸显示、NAI 5 Full Medium、V5 不支持 Vibe、切 4.5 自动关 NL | 上游 |
| 2 | NAI 接入点分账：`endpoints[].concurrency`、per-gate 闸门/冷却、官方内置只读条、迁移 | 上游 |
| 3 | 画师串库 UI：`NaiArtistLibrary` + `NaiArtistPicker` + `ArtistTile` + 预览图破缓存 | 上游（保留本地 vibe 绑定/参数快照/智绘姬导入） |
| 4 | NAI 出图方案库：`NaiPlan` + `activePlanId` + `effectiveNai()` + `NaiRunConfig` + 迁移 | 上游 |
| 5 | **Latent 原生 API 配置库**：多套出图参数 + 提示词 + 预览图，切换即生效 | 新增 |
| 6 | **删除旧 latent 渠道**：设置、面板、出图链路、提示词分段串一并清理 | 本轮决定 |
| 7 | ComfyUI 三库：服务器库 + 提示词库 + 方案引用（不含漫画 kind） | 上游 |
| 8 | 楼层图片沉浸显示 | 上游 |

### 不做（本轮）

| 项 | 理由 |
|---|---|
| 漫画方案 MOSS-Image（`mossLayout.ts` / `parseComicPlan` / MOSS 模板 / 卡片类型校验） | 老师明确先不做；且需要 ComfyUI 侧 MOSS-Image 模型环境才能验收 |
| 公开接口的漫画分支（`publicBackendStatus`） | 随漫画一起做 |
| 上游对 `size.ts` / `imageTagRegex.ts` / `protocol.ts` 删 `square`、`center`、`uc` 的改动 | 本地 Latent 原生 API 方形、世界书链依赖它们 |
| 上游对 `index.ts` 的「单步初始化不隔离」回退 | 本地 `runStep` 是修过的，保留 |
| 上游对 `storage.ts` / `public/api.ts` 内联 `btoa` 的改动 | 本地 `@/base64` 公共模块更干净 |

---

## 2. 现状盘点

| 能力 | 本地 0.3.3 | 上游 0.3.6 | 本轮 |
|---|---|---|---|
| NAI 参数 | 平铺在 `settings.nai` | `plans[]` + `activePlanId` + `NaiRunConfig` | 合上游 |
| NAI 接入点 | `endpoints[]`（url+key），并发全局一个 | `endpoints[]`（url+key+concurrency），官方条只读，per-gate 限流 | 合上游 |
| 画师串 | `NaiArtistPreset`（prompt/quality/negative/preview/vibes/params）+ 管理窗口 + 下拉 | 同字段（无 vibes/params）+ 就地展开的库 + Picker | 上游 UI + 本地能力 |
| 旧 latent 渠道 | `settings.latent` + `NaiPanel target='latent'` + `flatten` + `promptSections` | 无 | **删除** |
| Latent 原生 API | 扁平单套参数 + 全局 spec/thinking | 无此渠道 | **扩成配置库** |
| ComfyUI | 单 `url` + `workflows[]` | `servers[]` + `promptSets[]` + `workflows[]`（含 kind） | 合上游（不含 kind） |
| 楼层显示 | 显示大小四档 | 显示大小 + 沉浸显示 | 合上游 |

---

## 3. 总体设计

### 3.1 三层结构

```
渠道（连接：url/key）
  └─ 方案库（这次出图用哪套参数/画风）
       └─ 共享库（画师串 / Vibe / 接入点 / 提示词集 / 服务器，可被多套方案引用）
```

- **渠道级**只放“怎么连”：NAI 是接入点库（多个站），Latent 原生 API 是 url/key（一个站），ComfyUI 是服务器库。
- **方案级**放“这次怎么画”：模型、采样参数、尺寸、画幅锁、自然语言、引用哪条画师串/vibe/服务器/提示词。
- **共享库**放“可复用资产”：画师串、Vibe、提示词集、服务器。

### 3.2 UI 信息架构（不新开顶级页签）

渠道页现有页签删掉旧 latent 后剩四个（WebUI 仍隐藏）：

```
渠道 → NAI
├─ 出图方案（列表行 + 编辑弹窗）
│    └─ 编辑弹窗：接入点 / 模型 / 画师串 [选择…] / Vibe 勾选 / 采样参数 / 尺寸 / 自然语言
│         └─ [选择…] → NaiArtistPicker 弹窗（卡片网格 + 搜索 + 不使用）
├─ 画师串库（折叠区，就地展开）
│    └─ 卡片网格 + 搜索 + 新建/多选删/导入 + 编辑弹窗（含 vibe 绑定、参数快照）
├─ 接入点（折叠区）
│    └─ 列表 + 编辑弹窗（名字/地址/Key/并发数；官方条只读）
└─ Vibe 库（现有）

渠道 → Latent 原生 API
├─ 配置库（卡片网格 + 编辑弹窗）      ← 本次新增
│    └─ 编辑弹窗：出图参数 / 提示词 / 预览图
└─ 连接（折叠区：站点地址 / Key / 测试连接）

渠道 → ComfyUI
├─ 出图方案（列表行 + 编辑弹窗）
├─ 提示词库（列表行 + 编辑弹窗）
└─ 服务器（列表行 + 编辑弹窗）

渠道 → ImgRouter（现有，不动）
```

### 3.3 为什么 Latent 配置库不新开顶级页签

三个理由：

1. **渠道页已经是“选渠道 + 配参数”的唯一入口**。新开顶级页签会把“连接在渠道页、方案在新页、预览图又在别处”拆成三处，切渠道时还要跨页找配置。
2. **Latent 配置本质是渠道参数的多套快照**，与 NAI 方案库同层。放在同一面板内，切渠道、切配置、测试连接都在一屏内完成。
3. **现有导航按 `BackendId` 组织**（`pages/backend/index.vue` 的 `PANELS` 映射 + localStorage 页签记忆）。新增顶级页要改导航、页签存储、面板注册三处，收益不抵成本。

备选（不推荐）：新开“方案”顶级页，把 NAI 方案、Latent 配置、ComfyUI 方案都放进去。优点是集中；缺点是渠道连接与方案分离，且要重做导航。

### 3.4 Latent 配置库的 UI 形态：卡片网格

- 配置数量少（通常 3–10 套），每套带一张预览图，**看图选画风**比看名字快。
- 复用画师串库的视觉语言：`PreviewTile` 卡片、搜索阈值、多选删、编辑弹窗。
- 卡片内容：预览图（无图显示参数摘要：`8步 · euler · 竖`）、名称、当前配置高亮。
- 点击卡片 = 切换（立即生效 + toast）；✎ = 编辑；顶部「新建」「多选」。

---

## 4. 数据模型

### 4.1 NAI 方案（照上游）

```ts
export interface NaiPlan extends SizePair {
  id: string;
  name: string;
  endpointId: string;      // 引用接入点；悬空回落 endpoints[0]
  model: NaiModel;
  artistId: string;        // 空串 = 不使用画师串
  qualityTags: string;     // @deprecated 仅兼容存储
  undesiredContent: string;// @deprecated 仅兼容存储
  sampler: string;
  steps: number;
  scale: number;
  cfgRescale: number;
  noiseSchedule: string;
  seed: number;
  varietyBoost: boolean;
  normalizeRefStrength: boolean;
  vibeIds: string[];
  naturalLanguage: boolean;
  orientationLock: OrientationLock;
}

export interface NaiRunConfig extends SizePair {
  endpointId: string;
  url: string;
  key: string;
  model: NaiModel;
  artist: NaiArtistPreset | null;
  // ...采样参数同上
  vibes: NaiVibe[];
}
```

- `settings.nai` 增加 `plans: NaiPlan[]`、`activePlanId: string`。
- 消费方一律走 `activeNaiPlan()` / `effectiveNai(plan?)`；`backends/nai.ts` 只吃 `NaiRunConfig`。
- 本地增强：切换画师串时**保留** `applyArtistVibeState`（把画师串绑定的 vibe 套进当前方案 `vibeIds`），上游删了这段，本地留。

### 4.2 接入点分账

```ts
export interface NaiEndpoint {
  id: string;
  name: string;
  url: string;
  key: string;
  concurrency: number;     // 1–4，默认 1
}
export const OFFICIAL_NAI_ENDPOINT_ID = 'nep_official';
```

- `genQueue`：`gates: Map<string, Gate>`，`setNaiConcurrency(value, gateId)`，`acquireNaiSlot(signal, gateId)`。
- `naiRateLimit`：`pacing: Map<string, PacingState>`，所有函数加 `gate` 参数。
- `nai.ts` 的三个入口传 `gate = runConfig.endpointId`。
- 官方条 `nep_official` 只读：normalize 强制重建 url/name，只保留 key；UI 禁改禁删。

### 4.3 ComfyUI 三库（不含漫画）

```ts
export interface ComfyServer { id: string; name: string; url: string; }
export interface ComfyPromptSet {
  id: string; name: string;
  spec: string; thinking: string;   // 空 = 回落内置
}
export interface ComfyWorkflowPreset extends SizePair {
  // ...现有字段
  serverId: string;
  promptSetId: string;
}
```

- `settings.comfyui` 增加 `servers[]`、`promptSets[]`；`workflows[]` 加两个引用字段。
- 不加 `kind`（漫画阶段再加，避免半成品）。
- 内置提示词集只有一套「插画」：`BUILTIN_COMFY_ILLUST_ID = 'builtin_illust'`，内容 = 现有 `DEFAULT_COMFY_SPEC` / `DEFAULT_COMFY_THINKING`。
- `effectiveComfyConn()` 改读方案引用的服务器 url。

### 4.4 Latent 原生 API 配置（新增）

```ts
export interface LatentApiProfile {
  id: string;                  // lap_*
  name: string;
  /** 正向前缀（拼在 Scene 最前） */
  positivePrefix: string;
  /** 负面提示词 */
  negativePrompt: string;
  steps: number;               // 8–12
  sampler: LatentApiSampler;
  scheduler: LatentApiScheduler;
  seed: number;                // 0 = 随机
  naturalLanguage: boolean;
  orientationLock: OrientationLock;   // 多一档 square
  /** 书写规范；空串 = 回落设置页全局 latentApiSpec */
  spec: string;
  /** 思维链；空串 = 回落设置页全局 latentApiThinking */
  thinking: string;
  /** 预览图生成用的示例提示词（Scene 串，不含前缀） */
  previewPrompt: string;
  /** 预览图路径（user/images/柏宝绘_Latent配置/<id>.jpg） */
  previewPath?: string;
}
```

`settings.latentApi` 结构：

```ts
export interface LatentApiSettings {
  url: string;
  key: string;
  profiles: LatentApiProfile[];
  activeProfileId: string;
  // 以下为「当前配置」的镜像，出图代码继续读它们，零改动
  positivePrefix: string;
  negativePrompt: string;
  steps: number;
  sampler: LatentApiSampler;
  scheduler: LatentApiScheduler;
  seed: number;
  naturalLanguage: boolean;
  orientationLock: OrientationLock;
}
```

**镜像口径**（与 NAI 接入点镜像同思路）：
- `normalizeLatentApi` 收尾：`profiles` 恒非空（空则用扁平字段建「默认配置」）；`activeProfileId` 悬空回落 `profiles[0]`；镜像 = 当前配置。
- 面板切换配置：写 `activeProfileId` + 刷新镜像。
- 编辑弹窗保存：写 profile；若编辑的是当前配置，刷新镜像。
- 出图代码（`generateLatentApiImage`）签名不变，继续吃 `LatentApiSettings` 形状。

**提示词三级回落**：
```
配置.spec 非空 → 用它
配置.spec 空 → 设置页 autoTag.prompts.latentApiSpec 非空 → 用它
两者都空 → DEFAULT_LATENT_API_SPEC
```
思维链同理。改动点在 `autoTag/prompt.ts` 的 `backendPromptSpec` / `backendThinkingPrompt`。

**预览图**（与画师串同口径）：
- 存 `user/images/柏宝绘_Latent配置/<id>.jpg`，压成最长边 512 的 jpeg。
- 只当配置封面：**不进历史、不进图库**。
- 换图同名覆盖，`bumpPreview(id)` 破缓存；删配置时连带删文件；复制配置不带走预览图（避免共指一个文件）。
- 编辑弹窗「预览图」组：示例提示词 textarea + 「生成预览图」+ 「上传」+ 预览图展示 + 「删除」。
- 生成：用该配置的参数（steps/sampler/scheduler/seed/orientationLock/前缀/负面）调 `generateLatentApiImage`，提示词 = `latentApiPrompt({positivePrefix}, {prompt: previewPrompt, nl: '', characters: []})`。
- 生成中：按钮 loading + 可取消（AbortController）；失败 toast；超 2000 字提示。
- 默认示例提示词：`1girl, portrait, soft light, detailed face, upper body`（可按画风改）。

### 4.5 迁移

| 迁移 | 触发 | 口径 |
|---|---|---|
| `foldLegacyNaiPlan` | `settings.nai.plans` 不存在 | 老平铺字段折成唯一「默认方案」；`activeEndpointId`/`activeArtistId` 变引用；`enabled===true` 的 vibe 进 `vibeIds`；老平铺字段不再保留 |
| `migrateNaiEndpoints` | `endpoints[]` 无 `concurrency` | 老全局 `nai.concurrency` 分给每条；老平铺 url/key 收成第一条；第三方站建「我的接入点」放首位 |
| `foldLegacyComfyServers` | `servers` 不存在 | 老渠道级 `url` 折成第一台服务器 |
| `foldLegacyComfyPromptSets` | `promptSets` 不存在 | 设置页改过的 `comfySpec`/`comfyThinking` 折成一套用户提示词，全部方案引用；没改过的留空回落内置 |
| `foldLegacyLatentApiProfile` | `latentApi.profiles` 不存在 | 老扁平字段折成「默认配置」；`spec`/`thinking` 留空（回落全局，保持现状） |
| `migrateLegacyLatentRemoval` | `settings.latent` 存在 | `defaultBackend === 'latent'` → `'latentapi'`；删除 `settings.latent`；老 `history` 里的 `backend:'latent'` **保留只读**（老记录仍能显示标签） |

所有迁移**幂等**：靠字段有无判断，不写 `schemaVersion`；`profiles`/`plans`/`servers`/`promptSets` 存在但为空数组时按脏数据处理，不重迁。

### 4.6 回滚

- 迁移后老平铺字段不再保留（与上游同口径）。回滚到 0.3.3 会落回出厂值。
- 合入前备份 `extension_settings['baibai_image']`（`settings.json` 里那一段）。
- 每个阶段独立可回滚：阶段 1/2 只增字段；阶段 3/4/5/6 各自带迁移测试。

---

## 5. 分模块设计

### 5.1 P0 修正（4 项）

| 项 | 改动 | 文件 |
|---|---|---|
| 沉浸显示 | `ui.immersiveImages` + 卡片 `data-hide-ui` + 点图先唤控件再进灯箱 + 点外收起 | `settings.ts`、`Card.vue`、`card.css`、`pages/settings/index.vue` |
| NAI 5 Full Medium | `NAI_MODELS` 加一条；`naiFixedSettings()`（steps 14 / Euler Ancestral / cfg_rescale 0 / 负面清空）；采样器过滤；面板「官方固定」 | `settings.ts`、`nai.ts`、`NaiPanel.vue` |
| V5 不支持 Vibe | `naiSupportsVibes` 去掉 `isNai5`；面板禁用上传/勾选提示「勾选保留、出图跳过」 | `nai.ts`、`NaiPanel.vue` |
| 切 4.5 自动关 NL | 面板模型切换：从非 4.5 进 4.5 且 NL 开着 → 关 + toast；已有 4.5 方案/切方案不触发 | `NaiPanel.vue` |

### 5.2 接入点分账

1. `NaiEndpoint` 加 `concurrency`；`NAI_CONCURRENCY_MAX = 4`。
2. `genQueue` 改 `Map`，`setNaiConcurrency(value, gateId)`、`acquireNaiSlot(signal, gateId)`、`naiSlotBusy(gateId)`。
3. `naiRateLimit` 改 `Map`，`noteNaiRateLimited(retryAfter, now, gate)` 等全部加 `gate`。
4. `nai.ts` 的 `testNaiConnection` / `generateNaiImage` / `encodeVibeImage` 加 `gate`（从 `runConfig.endpointId` 取）。
5. `hydrate.ts` watch `settings.nai.endpoints.map(ep => [ep.id, ep.concurrency])`。
6. `NaiPanel` 接入点编辑弹窗加并发数（1–4）；官方条只读。
7. 迁移 `migrateNaiEndpoints`。

**保留**：本地 `latentApiGate`（Latent 原生 API 串行闸门）不动。

### 5.3 画师串库（采纳上游形态）

**新增**：

- `ArtistTile.vue`：预览图 / 无图占位 / 名称 / 内置标记 / 选中态 / 多选勾选。
- `artistPreview.ts`：预览图破缓存版本号（本地已有同款逻辑在 `NaiArtistManager`，抽出来共用）。
- `NaiArtistLibrary.vue`：就地展开的库（搜索阈值 6、卡片网格、多选删、内置只读、编辑弹窗、导入菜单）。
- `NaiArtistPicker.vue`：方案编辑里的挑选弹窗（卡片网格 + 搜索 + 「不使用」）。

**从本地 `NaiArtistManager.vue` 迁入 Library 的能力**：

| 能力 | 去处 |
|---|---|
| 预览图上传（512 jpeg / `user/images/柏宝绘_画师串/<id>.jpg`） | Library 编辑弹窗 |
| 搜索 / 多选删 / 复制 | Library |
| Vibe 绑定（`preset.vibes`） | Library 编辑弹窗「Vibe 绑定」折叠区 |
| 参数快照（`preset.params`） | Library 编辑弹窗「参数快照」折叠区 + 「应用参数」按钮 |
| 智绘姬导入 / 预设文件导入导出 | Library 顶部「导入」菜单 |

**删除**：`NaiArtistManager.vue`。

**保留**：

- `NaiPanel` 的「画师串」下拉（高频切换）。
- `Card.vue` 的楼层画师串快捷浮层（本地功能，上游删了）。
- `naiArtistLib.ts` 的 `applyArtistVibeState` / `snapshotNaiPresetParams` / `applyNaiPresetParams`。

**交互口径**：
- 库内点一行 = 打开编辑，不切换（避免误触，与上游一致）。
- 切换画师串只在方案编辑的 Picker、面板下拉、楼层浮层三处发生。
- 切换时套用画师串的 vibe 绑定（本地增强）。

### 5.4 NAI 方案库

**数据层**：

- `NaiPlan` / `NaiRunConfig` / `activeNaiPlan()` / `effectiveNai()` / `newNaiPlan()`。
- `normalizeNai` 收尾：`plans` 恒非空；`endpointId` 悬空回落 `[0]`；`artistId` 悬空清空；`vibeIds` 剔除不存在 id；`activePlanId` 悬空回落 `[0]`。
- `foldLegacyNaiPlan` 迁移。

**后端**：

- `nai.ts` 所有公开函数改吃 `NaiRunConfig`（`naiArtistPrompt` / `naiQualityTags` / `naiUndesiredContent` / `fullPositivePrompt` / `fullNegativePrompt` / `buildNaiParameters` / `applyVibes`）。
- `generateNaiImage(runConfig, values, signal, opts)`，`opts.gate = runConfig.endpointId`。

**生成链路**：

- `generate.ts`：`backendStatus` 的 model 取 `activeNaiPlan().model`；`generateImage` 的 NAI 分支传 `effectiveNai()`；`decideSeed` 取 `activeNaiPlan().seed`。
- `Card.vue`：`activeBackend` / 历史模型名改取方案；楼层浮层切换画师串写 `activeNaiPlan().artistId`。
- `public/api.ts`：`getBackendStatus` 的 model 改取方案。

**面板**：

- 顶部「出图方案」列表（名字 / 模型 / 尺寸 / ✎ / 新建）。
- 编辑弹窗：接入点下拉、模型下拉、画师串 [选择…]（Picker）、Vibe 勾选（按方案 `vibeIds`）、采样参数、尺寸、自然语言、画幅锁。
- 「画师串库」折叠区放 Library。
- 「接入点」折叠区放列表 + 编辑弹窗。

### 5.5 Latent 原生 API 配置库（新）

**数据层**：

- `LatentApiProfile` / `settings.latentApi.profiles` / `activeProfileId` / 镜像字段。
- `activeLatentApiProfile()` / `newLatentApiProfile()` / `latentApiProfileToConn()`（profile → `LatentApiSettings` 出图形状）。
- `normalizeLatentApi` 扩展 + `foldLegacyLatentApiProfile`。

**提示词**：

- `autoTag/prompt.ts` 的 latentapi 分支：`spec` / `thinking` 读 `activeLatentApiProfile()?.spec || prompts?.latentApiSpec`（三级回落）。
- 设置页 `latentApiSpec` / `latentApiThinking` 保留为「全局默认」，加说明「配置里可覆盖」。

**预览图**：

- `st/images.ts` 加 `LATENT_PROFILE_PREVIEW_FOLDER = '柏宝绘_Latent配置'`。
- `LatentApiPanel.vue` 的配置编辑弹窗：
  - 示例提示词 textarea。
  - 「生成预览图」：`generateLatentApiImage(profileToConn(profile), { prompt: previewPrompt, nl: '', characters: [], seed: profile.seed || 随机, size })`。
  - 结果压成 512 jpeg → `uploadUserImage(...)` → `previewPath`。
  - 「上传」：`makeJpegThumbnail` + `uploadUserImage`（备用）。
  - 「删除」：`deleteUserImage`。
  - 生成中 loading + 取消；失败 toast；超限提示。

**面板**：

- 顶部「配置库」卡片网格（`PreviewTile` 复用）+ 新建/多选/搜索（阈值 6）。
- 点击卡片切换；✎ 编辑。
- 「连接」折叠区：url / key / 测试连接（现有内容保留）。

**切换语义**：

- 切配置 = 写 `activeProfileId` + 刷新镜像 + toast。
- 已在途的出图不重排；下一张起用新配置。
- 自动 tag 下次请求用新 `spec`/`thinking`。

### 5.6 删除旧 latent 渠道

**数据层**：

- `BackendId` 去掉 `'latent'`；`BACKENDS` / `SELECTABLE_BACKENDS` 去掉。
- `settings.latent` 字段、`latentDefaults()`、`normalizeLatent()` 删除。
- 迁移 `migrateLegacyLatentRemoval`：`defaultBackend === 'latent'` → `'latentapi'`；删除 `settings.latent`。

**出图链路**：

- `generate.ts`：删 `latent` 分支、`hasClientGate` 里的 latent 判据。
- `backends/nai.ts`：删 `flatten` 参数、`promptSections` 依赖、`characterCenterPoint` 之外与 latent 相关的分支。
- `backends/promptSections.ts`：删除。
- `floor/genQueue.ts`：删 latent 的闸门判据（保留 `latentApiGate`）。
- `floor/hydrate.ts`：删 latent 的 concurrency watch（改 endpoints watch）。
- `floor/Card.vue`：删 `latentActive` 与对应提示文案。
- `public/api.ts`：删 latent 分支与错误映射。

**面板与设置**：

- `pages/backend/index.vue`：`PANELS` 去掉 `latent`；`panelTarget` 删除。
- `NaiPanel.vue`：去掉 `target` prop 与 latent 分支，只服务 NAI。
- `autoTag/prompt.ts`：`naiProtocolBackend()` / `naiProtocolConn()` 只读 `settings.nai`。
- `autoTag/runner.ts`：删 latent 引用。
- `pages/settings/index.vue`：删 latent 相关说明。
- `state/history.ts`：`ImageBackend` **保留 `'latent'` 只读**（老记录标签），新记录不再产生。
- `pages/history/index.vue`：标签保留，筛选里可保留「Latent（旧）」或直接显示历史标签。

**验收**：

- 渠道页只剩 NAI / Latent 原生 API / ComfyUI / ImgRouter 四个页签。
- `settings.latent` 不再存在；`grep -r "settings.latent"` 无残留。
- 出图链路无 latent 分支；`pnpm typecheck` 通过。
- 老历史里的 `latent` 记录仍显示标签。

### 5.7 ComfyUI 三库（不含漫画）

- `settings.comfyui` 加 `servers[]` / `promptSets[]`；`workflows[]` 加 `serverId` / `promptSetId`。
- `effectiveComfyConn()` 读方案引用的服务器。
- `ComfyUIPanel` 重排为三块：出图方案 / 提示词库 / 服务器。
- 提示词库：`spec` + `thinking` 两个 textarea，空 = 回落内置；内置一套「插画」只读。
- 迁移 `foldLegacyComfyServers` / `foldLegacyComfyPromptSets`。
- `autoTag/prompt.ts` 的 comfy 分支：`spec` / `thinking` 读方案引用的提示词集（空回落内置）。
- **不做** `kind` / 漫画模板 / MOSS。

### 5.8 沉浸显示

- `ui.immersiveImages: boolean`（默认 false）。
- `Card.vue`：`immersive` / `uiHidden` / `uiRevealed`；点图先唤控件，再点进灯箱；点卡片外收起；`menuOpen` 时必然浮现。
- `card.css`：`[data-hide-ui='1']` 下隐藏菜单与翻页器。
- 设置页加开关 + 说明。

---

## 6. 文件清单

### 新增

```
src/pages/backend/panels/ArtistTile.vue
src/pages/backend/panels/artistPreview.ts
src/pages/backend/panels/NaiArtistLibrary.vue
src/pages/backend/panels/NaiArtistPicker.vue
src/pages/backend/panels/LatentApiProfileGrid.vue      （或内联在 LatentApiPanel）
src/pages/backend/panels/LatentApiProfileEditor.vue
src/backends/latentApiProfile.ts                       （纯函数：镜像/归一/预览提示词）
src/state/settings.latentApiProfiles.test.ts
src/state/settings.naiPlans.test.ts
src/state/settings.naiEndpointMigration.test.ts
src/state/settings.comfyLibraries.test.ts
src/state/settings.legacyLatentRemoval.test.ts
src/floor/genQueue.gates.test.ts
src/backends/naiRateLimit.gates.test.ts
```

### 修改

```
src/state/settings.ts               数据模型 + 迁移 + 镜像 + 删 settings.latent
src/backends/nai.ts                 NaiRunConfig / fixed / vibes / gate / 删 flatten
src/backends/naiRateLimit.ts        per-gate
src/backends/naiArtistLib.ts        保留 + 小补
src/backends/latentApi.ts           不改签名，补 profileToConn 兼容
src/backends/comfyTemplates.ts      只加提示词集回落（不含 moss）
src/generate.ts                     effectiveNai / activeNaiPlan / 删 latent 分支
src/floor/genQueue.ts               per-gate / 删 latent 判据
src/floor/hydrate.ts                endpoints watch / 删 latent watch
src/floor/Card.vue                  沉浸 + 方案化 model 读取 + 删 latentActive（保留楼层浮层）
src/floor/card.css                  沉浸样式
src/autoTag/prompt.ts               latentapi spec/thinking 读配置；comfy 提示词集；删 latent 分支
src/autoTag/runner.ts               模型/配置读取；删 latent 引用
src/pages/backend/panels/NaiPanel.vue        方案库 + 画师串库 + 接入点；删 target
src/pages/backend/panels/ComfyUIPanel.vue    三库
src/pages/backend/panels/LatentApiPanel.vue  配置库
src/pages/backend/index.vue         删 latent 页签与 panelTarget
src/pages/settings/index.vue        沉浸开关 + 提示词说明 + 删 latent 说明
src/public/api.ts                   model 取方案；删 latent 分支
src/st/images.ts                    LATENT_PROFILE_PREVIEW_FOLDER
src/state/history.ts                类型保留 latent 只读，注释说明
```

### 删除

```
src/pages/backend/panels/NaiArtistManager.vue   （能力迁入 Library）
src/backends/promptSections.ts                  （旧 latent 分段串）
```

### 明确不动

```
src/backends/size.ts                square / orientationOfSize 保留
src/st/imageTagRegex.ts             center/uc 保留
src/autoTag/protocol.ts             center/uc 保留
src/state/history.ts 的 latent 值     仅保留只读标签
src/generationMeta.ts               五后端保留
src/st/context.ts                   STChatCompletionSettings 保留
src/index.ts                        runStep 隔离保留
src/base64.ts                       bytesToBase64 保留
src/backends/imgRouter.ts           不动
src/backends/latentApi.ts 的出图协议  不动
dist/                               不直接覆盖上游产物
```

---

## 7. 分阶段实施

| 阶段 | 内容 | 验收 | 依赖 |
|---|---|---|---|
| 0 | 备份设置、建分支、迁移测试骨架 | `pnpm test` 绿 | — |
| 1 | P0 四项（沉浸 / 5-full-medium / V5 vibe / 4.5 自动关） | 单测 + 手测四项 | — |
| 2 | 接入点分账（settings / genQueue / naiRateLimit / nai / hydrate / 面板） | 两站互不冻结；Latent 原生 API 仍串行 | 阶段 1 |
| 3 | 删除旧 latent 渠道（数据层 → 出图链路 → 面板/设置 → 迁移） | 渠道页四页签；无 `settings.latent` 残留；老历史仍显示 | 阶段 2 |
| 4 | 画师串库（Tile / Library / Picker / 预览图 / 迁入能力） | 库增删改搜、预览图、导入导出、vibe 绑定 | 阶段 3 |
| 5 | NAI 方案库（数据层 → 后端 → 生成链路 → 面板） | 切方案整套生效；迁移后出图效果不变 | 阶段 4 |
| 6 | Latent 原生 API 配置库（数据层 → 提示词 → 预览图 → 面板） | 切配置生效；预览图可生成；spec 三级回落 | 阶段 3（可与 5 并行） |
| 7 | ComfyUI 三库（数据层 → 生成链路 → 面板） | 多服务器/多提示词集可切换；迁移不丢地址 | 阶段 3 |

**建议顺序**：1 → 2 → 3 → 4 → 5 → 6 → 7。阶段 6 与 5 无强依赖，可提前。

---

## 8. 测试

### 单测

- `settings.naiPlans.test.ts`：迁移、引用修复、`plans` 恒非空、老字段不留。
- `settings.naiEndpointMigration.test.ts`：官方条只读、并发分配、第三方站首位。
- `settings.comfyLibraries.test.ts`：服务器/提示词集迁移、引用修复、空数组不重迁。
- `settings.latentApiProfiles.test.ts`：迁移、镜像、悬空回落、三级回落。
- `settings.legacyLatentRemoval.test.ts`：`defaultBackend` 改写、`settings.latent` 删除、老历史保留。
- `genQueue.gates.test.ts`：两站独立并发、429 冷却不串站。
- `naiRateLimit.gates.test.ts`：per-gate 冷却/最小间隔。
- `latentApi.test.ts`：`latentApiPrompt` 不变；新增 `profileToConn` 形状。

### 手工验收

- NAI：切方案后模型/画师串/vibe/尺寸/自然语言全变；楼层浮层切画师串写进当前方案。
- 接入点：A 站 429 时 B 站照常出图；官方条不能改名/改址/删除。
- 画师串库：新建/搜索/预览图/复制/多选删/导入智绘姬；内置条只读。
- Latent 配置：新建/切换/编辑/删除；预览图生成与取消；超 2000 字提示；spec 留空回落全局；预览图不进图库。
- 旧 latent 删除：渠道页四页签；老聊天里的 latent 图仍能看；老历史标签仍显示；`defaultBackend` 自动切到 latentapi。
- ComfyUI：多服务器切换；提示词集切换；迁移后地址不丢。
- 沉浸显示：有图时菜单隐藏，点图唤出，点外收起，再点进灯箱。
- 回归：ImgRouter 不进 NAI 闸门；世界书生图 `center/uc` 仍生效；公开接口 `getBackendStatus` 在四后端下正确。

### 命令

```
pnpm test
pnpm typecheck
pnpm build
```

---

## 9. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| 删除旧 latent 渠道 | 老用户配置丢失 | 迁移前备份；`defaultBackend` 自动切 latentapi；设置页/面板明确提示「旧 Latent 已移除，改用 Latent 原生 API」 |
| 老历史 `latent` 记录 | 标签显示异常 | `ImageBackend` 保留 `'latent'` 只读，不迁移记录 |
| `NaiPanel.vue` 重写回归 | 面板功能丢失 | 阶段 5 拆成「数据层 → 后端 → 生成链路 → 面板」四步；面板改动前先录屏旧行为 |
| 设置结构大改 | 用户配置丢失 | 合入前备份 `settings.json`；迁移幂等；每个迁移带测试 |
| 预览图生成消耗额度 | 用户意外扣费 | 按钮文案「生成预览图（会真实出图）」；可取消；失败不重试 |
| Latent 配置 spec 优先级 | 用户改了全局却不生效 | 三级回落 + 编辑弹窗显示「当前生效：配置 / 全局 / 内置」 |
| 画师串库删旧管理器 | 本地 vibe 绑定/参数快照丢失 | 迁入 Library 并加测试；保留 `naiArtistLib` 函数 |
| 版本号 | 回滚困难 | 升 `0.3.7`；迁移后老版本读不到新字段会落回出厂值（与上游同口径） |

---

## 10. 已拍板

| 项 | 决定 |
|---|---|
| Latent 配置库 UI | 面板内卡片网格 |
| 旧 latent 渠道 | 删除（原生 API 已覆盖） |
| 版本号 | `0.3.7` |
| 预览图 | 与画师串同口径：只当封面、不进图库/历史、删配置连带删文件、换图破缓存 |
| `NaiArtistManager.vue` | 删除，能力迁入 Library |

---

## 11. 实施记录（2026-11-18）

### 已完成

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | 沉浸显示、NAI 5 Full Medium、V5 不支持 Vibe、切 4.5 自动关 NL | 完成 |
| 2 | 接入点分账：`endpoints[].concurrency`、per-gate 闸门/冷却、迁移 | 完成 |
| 3 | 删除旧 latent 渠道（设置/面板/出图链路/历史只读） | 完成 |
| 4 | 画师串库：`ArtistTile` / `NaiArtistLibrary` / `artistPreview`，`NaiArtistManager` 删除 | 完成 |
| 5 | NAI 方案库：`NaiPlan` / `activePlanId` / `effectiveNai` / `NaiRunConfig` / 迁移 | 完成 |
| 6 | Latent 原生 API 配置库：`LatentApiProfile` / 卡片网格 / 编辑弹窗 / 预览图 | 完成 |
| 7 | ComfyUI 三库：`servers` / `promptSets` / 方案引用 / 迁移 | 完成 |

### 与计划的差异

- **画师串 Picker 未单独做**：方案编辑里选画师串仍用面板下拉；库本身已就地展开（搜索/预览图/多选删/导入导出/Vibe 绑定/参数快照）。后续要做 Picker 时，`ArtistTile` 已可复用。
- **ComfyUI 设置页的全局规范/思维链保留**：作为「方案没选用户提示词集时的回落层」；方案引用的用户提示词集优先。没有把设置页入口删掉，避免老用户找不到。
- **旧 latent 历史记录只读**：`ImageBackend` 保留 `'latent'` 值，老记录标签仍能显示；新记录不再产生。
- **预览图**：与画师串同口径，存 `user/images/柏宝绘_Latent配置/<id>.jpg`，只当封面，不进图库/历史。
  另外，用该配置正常出图成功后会自动取一张当封面（仅当还没有封面时），不额外消耗额度；
  编辑弹窗里的「生成预览图」仍保留，用于主动换封面。

### 验证

- `vitest run`：**793 passed / 3 skipped**（796 项）
- `vue-tsc --noEmit`：通过
- `vite build`：成功，`dist/index.js` 0.3.7（740 KB）
- `manifest.json` / `package.json`：0.3.7

### 使用提醒

- **设置迁移不可逆**：老平铺参数已折进方案/配置/库；回滚到 0.3.3 会落回出厂值。升级前请备份 `settings.json` 里的 `baibai_image` 段。
- **旧 latent 渠道已移除**：`defaultBackend='latent'` 会自动切到 `latentapi`，但旧渠道的地址/Key 不迁移，需要在「Latent 原生 API」里重填。
- **生成预览图会真实出图**：消耗一次接口额度；可取消；失败不重试。
- **漫画方案（MOSS-Image）未做**：`ComfyKind` / `mossLayout` / `parseComicPlan` / MOSS 模板 / 卡片类型校验都留给下一轮。

### 未纳入本轮

- 漫画方案（MOSS-Image）
- 画师串 Picker 弹窗（用下拉替代）
- 公开接口的漫画分支

