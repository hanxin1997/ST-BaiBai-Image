# PLAN: Latent 原生 API 出图串行化（渠道并发 = 1）

## 问题

世界书生图会把一楼里的多个 `image###…###` 块一次转成多张卡片，并给每个槽位挂自动出图标记。
卡片水合后各自调用 `generateImage()`。当前只有 `nai` / `latent` 走 `floor/genQueue.ts` 的客户端闸门，
**`latentapi` 没有任何客户端排队**，多个请求会同时打到渠道。该渠道并发只有 1，并发请求会失败。

要求：该渠道所有出图请求一个完成才发下一个（不只是世界书生图触发的那一批）。

## 方案

在现有闸门模块里新增 Latent 原生 API 专用闸门，固定并发 1；`generateImage()` 对 latentapi
持槽直到「任务成功 + 原图下载完成」才 release。卡片与公开接口走同一条路，全部自动串行。

**不做的事**

- 不加设置项：渠道并发就是 1，固定命名常量，避免多一个会被误调的旋钮。
- 不改世界书生图的标记逻辑；串行在渠道闸门层解决，手动点其它卡片同样排队。
- 不动 NAI 闸门的并发上限与 429 节奏逻辑。

## 改动文件

### 1. `src/floor/genQueue.ts`

- 抽出通用队列状态 `Gate` + `pumpGate()` + `takeSlot(gate, signal)`，现有 NAI 行为逐字保持。
- `acquireNaiSlot` = `takeSlot(NAI 闸门)` + 原有节奏等待（持槽等待、取消归还槽位不变）。
- 新增：
  - `LATENT_API_CONCURRENCY = 1`（命名常量）
  - `acquireLatentApiSlot(signal)` → `takeSlot(Latent 原生 API 闸门, signal)`
  - 不套 NAI 的节奏等待：该渠道是「排队 + 轮询」协议，不是 NAI 的阻塞式 POST。
- 更新文件头注释，说明两道闸门各自存在的理由。

### 2. `src/generate.ts`

- 新增 `hasClientGate(backend)`：`nai` / `latent` / `latentapi` 为 true。
- `generateImage()`：
  - `isNaiProtocol` → `acquireNaiSlot`
  - `latentapi` → `acquireLatentApiSlot`
  - release 仍在 `finally`，异常/取消都不漏槽。
- 更新头部注释里的闸门覆盖范围。

### 3. `src/floor/Card.vue`

- 初始相位改用 `hasClientGate(settings.defaultBackend)`：latentapi 排队时先显示「排队中…」，
  取到槽后 `onStart` 转「生成中…」。
- 注释同步。

### 4. `src/public/api.ts`

- 初始进度同样用 `hasClientGate`，latentapi 排队时先报 `queued`。

### 5. `src/public/api.test.ts`

- mock 增加 `hasClientGate`（接口变更的调用方同步，不新增测试）。

### 6. `src/public/types.ts`

- `phase='queued'` 的说明从「NAI 并发闸门」改为「出图并发闸门（NAI 系 / Latent 原生 API）」。

## 行为

- 世界书生图一楼 3 张：卡片按 seq 顺序入队；第 1 张跑完（轮询到 succeeded + 原图下载完）
  才发第 2 张，依此类推。
- 排队中的卡片显示「排队中…」；取消排队中的请求立刻从队列摘除，不占槽；
  取消生成中的请求会中止 fetch/轮询并在 `finally` 释放槽。
- 公开接口在 latentapi 排队时先报 `queued`，取槽后报 `generating`。
- 切聊天 / 删楼：`clearAllGen` 中止全部，槽位释放。
- ComfyUI / ImgRouter / NAI 行为不变。

## 风险

- 固定并发 1：将来渠道允许更高并发时需要改成设置项。
- 队列是模块级、按浏览器实例；多标签页各排各的（与现有 NAI 闸门一致）。
- latentapi 单任务最长 10 分钟轮询超时；期间队列会等待，这是并发 1 的固有代价。

## 验证

- `pnpm typecheck`
- `pnpm test`（现有 genQueue / generate / public api 测试不回归）
- `pnpm build`
- 手动：世界书生图一楼多张 → 网络面板确认 `/api/generate` 逐个发出。
