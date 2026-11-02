# 计划:合入上游 ST-BaiBai-Image 0.2.7 快照

对照对象:`ST-BaiBai-Image-main/`(2026-09-20 拷入,`package.json` 写 0.2.7)。
我方:`0.3.0` 分支,版本号自己涨过,但上游代码更新(公开接口、图库落盘、卡片自愈)。

**本文件只是方案。未批准前不改 `src/`。**

---

## 已确认(用户拍板)

| 项 | 选择 |
|---|---|
| 图库 | **用上游图库整页换掉**当前聊天 extra 扫图方案 |
| 公开接口 | **一起合** `globalThis.STBaiBaiImage` |
| 范围 | P0 bugfix + P1(图库落盘 + generate 抽取 + 公开接口) |
| 我方功能 | **全部保留**:ImgRouter / Latent / NAI 多站点 / tag 备用渠道 / 进度 toast |

---

## 一、两边各有什么

### 我方独有(禁止覆盖)

| 模块 | 作用 |
|---|---|
| `src/backends/imgRouter.ts` + `ImgRouterPanel.vue` | 第三条出图链 |
| `src/backends/promptSections.ts` | Latent 分段串打包 |
| `settings.latent` + `NaiPanel target` | Latent 独立存储、面板复用 |
| `NaiEndpoint` / `activeEndpointId` | NAI/Latent 多站点 |
| `assignments.tagGenFallback` + `autoTag/notice.ts` | tag 备用渠道 + 常驻进度 toast |
| `history.ts` 的 `ImageBackend = nai\|latent\|comfyui\|imgrouter` | 请求历史标签 |
| `SELECTABLE_BACKENDS` | 渠道页/设置页/迁移同一份名单 |
| 版本 `0.3.0` | 禁止降回 0.2.7 |

### 上游独有(要合)

| 模块 | 作用 |
|---|---|
| `src/generate.ts` | 楼层卡片与公开接口共用的出图中段(含 NAI 闸门) |
| `src/public/*` | `STBaiBaiImage` 公开接口 |
| `src/floor/chatObserver.ts` | `#chat` 唯一 MutationObserver |
| `src/floor/slotHealth.ts` | 卡片「还活着吗」判据 |
| `src/floor/missingImages.ts` | 图库删文件后,卡片运行时降级破指针 |
| `src/base64.ts` / `src/bytes.ts` / `src/pool.ts` | utf8 安全 base64、体积格式化、限并发 map |
| 图库整页 | `user/images/柏宝绘_<角色>/` 跨聊天浏览 |
| 落盘改道 | 新图进 `user/images`,侧写 json 进 `user/files` |
| `st/images.ts` 列举/HEAD | `listUserImageFolders` / `listUserImages` / `probeUserImage` |

### 上游修、我方没有的 bug(P0)

1. **旁白楼 tag 漏出正文**。`/narrator` 楼 `extra.type='narrator'`,显示 placement=3。我方正则只挂 `[1,2]`,锚点不命中 → DOMPurify 剥壳,用户看到一串 danbooru tag,没有卡片。
2. **卡片被 ST 静默拆掉**。`updateMessageBlock` / 编辑取消 / 右滑 直接 `.mes_text.html(...)` 且不发事件。锚点连同 shadow 被删,`genState` 还在跑 → 「图在生成,楼层里没界面」。
3. **V5 Full 默认负面打架**。我方把 chibi / 大胸 / 暗调 / 具体画师名都禁了,跟正向词和画师串长期冲突。上游改成只排缺陷。
4. **自动 tag 把无名角色裁出画面**。上游改了协议:建档资格 ≠ 入画资格;镜头内无名个体也写 Character Prompt;优先主角、不为凑热闹加人。
5. **`btoa` 遇中文抛错**。上游抽 `utf8ToBase64`(TextEncoder 路径)。我方 `vibeStore.ts` 已有同款私有函数,抽公共模块即可。

---

## 二、不能整文件覆盖的冲突

| 文件 | 上游想改 | 我方必须留 | 合入方式 |
|---|---|---|---|
| `src/backends/nai.ts` | 换 V5 Full 默认负面;删 `flatten` | `flatten` + `promptSections`(Latent 定义) | **只换负面词常量 + 配套测试**;`flatten` 一行不动 |
| `src/generate.ts`(新) | 只认 `nai` / `comfyui` | ImgRouter / Latent | 拷过来后扩 `backendStatus` / `decideSeed` / `generateImage` |
| `src/floor/Card.vue` | 改走 `generateImage`;破图降级 | 五路后端提示、历史 `ImageBackend`、Latent 闸门 | 卡片改调 `generateImage`;pendingHint / 历史标签仍按五路 |
| `src/floor/hydrate.ts` | 自愈层;watch `settings.nai.concurrency` | 闸门跟随当前渠道(nai **或** latent) | 合自愈;**保留**我方 concurrency watch |
| `src/state/settings.ts` | 后端只有 nai/comfyui | 整份 fork 设置 | **禁止**用上游覆盖。本轮不动(除 generate 只读现有字段) |
| `src/autoTag/prompt.ts` | 协议修词;删 imgrouter/latent 分支 | ImgRouter 规范、`naiProtocolBackend()` | **只合协议三段文字**;分支保留 |
| `src/autoTag/runner.ts` | 单渠道重试 | 渠道链 + notice | **整文件不碰** |
| `NaiPanel.vue` / `NaiArtistManager.vue` / `pages/backend/index.vue` / `pages/settings/index.vue` | 去掉 target / 多站点 / ImgRouter 页签 | 全是我方功能 | **整文件不碰** |
| `src/state/history.ts` / `pages/history/index.vue` | 后端收窄成 nai\|comfyui | `latent` / `imgrouter` 标签 + `promptSections` 分段 | **整文件不碰** |
| `package.json` / `manifest.json` | `0.2.7` | `0.3.0` | 不降版本 |
| `README.md` / `architecture.md` | 上游加了公开接口说明 | 我方文档/架构已分叉 | 本轮不改(公开接口契约拷 `PUBLIC_API.md` 并补后端名单) |

---

## 三、图库换档:语义变化(已接受)

| | 我方现在 | 合入后 |
|---|---|---|
| 数据源 | 当前聊天 `extra.bbiImage` | `user/images` 下列 `柏宝绘_*` 目录 |
| 范围 | 仅当前聊天 | 跨聊天 |
| 新图落盘 | `user/files/bbi_*.png` 平铺 | `user/images/柏宝绘_<角色名>/bbi_*.<ext>` |
| 提示词 | extra 里现成 | 本聊天 extra 预填;其它聊天读侧写 json |
| 删除 | 删文件 **且** 摘 extra 指针 | **只删文件**(无反向索引)。破指针由卡片 `missingImages` 运行时降级 |
| 旧图 | 图库能列出 | **楼层卡片仍能看** `/user/files/...`;**新图库不列旧图**(不迁移) |

旧图不进新图库是刻意取舍,与上游一致。不写迁移脚本。

删 `src/pages/gallery/collect.ts`(只服务旧图库)。

---

## 四、`generate.ts` 必须扩的三处

上游原件只处理 nai/comfyui。不扩就等于公开接口和卡片一起把 Latent/ImgRouter 弄丢。

### 4.1 `backendStatus()`

| backend | configured | model | supportsCharacters |
|---|---|---|---|
| `nai` | url+key | `settings.nai.model` | `naiSupportsCharacterPrompts(model)` |
| `latent` | url+key(`settings.latent`) | `settings.latent.model` | 同上,读 latent 的 model |
| `imgrouter` | url+key | `settings.imgrouter.model` 或 `'(渠道默认)'` | **false**(无角色分区) |
| `comfyui` | 与上游相同(simple 走 `validateSimpleConfig`) | 当前预设名 | false |
| 其它 | false | `''` | false |

reason 文案沿用卡片现有 `pendingHint`(NAI / Latent / ImgRouter / ComfyUI 各一句)。

### 4.2 `decideSeed()`

- 显式 override > 0 → 用它
- `imgrouter` → **恒 0**(协议无 seed;`BbiImageEntry.seed` 不支持 -1)
- `nai` / `latent` → 该渠道 `seed > 0` ? 固定 : `naiRandomSeed()`
- 其余 → Comfy `randomSeed()`

### 4.3 `generateImage()`

闸门:**只有 nai 与 latent 持 `acquireNaiSlot`**。ImgRouter / ComfyUI 不持槽。

分派:

- `imgrouter` → `generateImgRouterImage(settings.imgrouter, { prompt, nl, size }, signal)`
- `nai` / `latent` → `generateNaiImage(对应 conn, { ..., flatten: backend==='latent' }, signal, onRetry)`
- `comfyui` → 与上游相同

`charactersApplied`:`characters.length > 0 && supportsCharacters`(ImgRouter/Comfy 恒 false,与「不降级拼进 prompt」同一口径)。

卡片 `runGeneration` / `acquireNaiSlot` / `pickSeed` / `configured` 删掉,改调这两个函数。卡片仍负责:beginGen / 历史埋点 / 落盘 / 重水合。`activeBackend()` 与 `historyModel()` 留在卡片(历史类型是我方的)。

公开接口 `public/api.ts` 的 `toPublicError` 要认 `ImgRouterError`(若存在)→ `backend_error`;429 文案仍走现有正则兜底。`report({ phase })` 里 queued 判据改为「nai 或 latent」,不能只看 `backend === 'nai'`。

---

## 五、落盘改道要点

`saveImageResult` 不再 `uploadImageFile`(user/files 平铺)。

新路径唯一入口:`uploadImageWithSidecar`:

1. `prepareImageForStorage`(JPG 开关,已有,保留)
2. `uploadUserImage('柏宝绘_'+characterName, imageFile, base64, format)`
3. 角色名取 `ctx.chat[messageId].name` 回落 `ctx.name2` 回落 `'未命名角色'`(**不要**再用 chatId 当文件名——目录名是图库分组键)
4. 侧写 json 失败只 `console.warn`,不抛(图已经在)

另加 `saveExternalImage`(公开接口 `save` 默认开,不写 extra)。

`deleteImageFileOnly`:删 user/images 文件 + 侧写;404 当成功。图库走它,不走 `deleteImageResult`。

`resultToBase64` 的分块 btoa 改调 `bytesToBase64`(`src/base64.ts`),别留第三份。

`vibeStore.ts` 删私有 `bytesToBase64`/`utf8ToBase64`,改 import `@/base64`。

---

## 六、卡片自愈

新文件原样拷:

- `src/floor/chatObserver.ts`
- `src/floor/slotHealth.ts` + 测试
- `src/floor/missingImages.ts` + 测试

`actionButton.ts`:拆掉自己的 MutationObserver,改 `onChatMutation(syncButtons)`。

`hydrate.ts`:

- `bindFloorHydration` 末尾调 `bindSlotSelfHealing`
- 合入 `healSlots` / `warnHiddenByHost` / `hiddenWarned`
- `CHAT_CHANGED` 时 `hiddenWarned.clear()`
- **concurrency watch 保持我方写法**(跟随 latent/nai)

`Card.vue` 另合:

- `liveHistory` / `liveStale` 过滤 `isImageMissing`
- `@error` → `confirmImageMissing`
- `filesGone` 文案「图片文件已删除」
- `promptText` 改调 `formatPromptText`(与图库同一口径)
- 灯箱继续传 `onDelete`;上游删了 `deletable` 字段,我方若模板还在用就跟着删字段、只留 `onDelete`

---

## 七、自动 tag 协议(只改字,不改分支)

`src/autoTag/prompt.ts` 三处换成上游措辞,`naiProtocolBackend()` / imgrouter 分支不动:

1. `contentRule`(naiCharPromptsOn 那条英文):镜头内每个个体都写 Character Prompt,含无名;人群留 Base
2. `newCharacterRule` 加「建档资格与入画资格是两回事」+ 无名角色不走二选一
3. 规则 6:优先玩家/主要角色;不为凑热闹加人

`prompt.test.ts` 若有锁这三段文案的断言,跟上游对齐;**我方独有的 `notifyProgress` / imgRouter 字段补全保留**。

---

## 八、公开接口

拷贝:

- `src/public/api.ts` / `register.ts` / `types.ts` 及测试
- `PUBLIC_API.md`(契约面;补 `backend` 枚举含 `latent` / `imgrouter`,`supportsCharacters` 对这两条的说明)

`index.ts` `hydrateWhenReady` 在 `bindTagActionButtons()` 之后、`checkForUpdate` 之前调 `registerPublicInterface()`。注释沿用上游:必须在 `hydrateSettings` + `bindCharTagSync` 之后。

`types.ts` 的 `backend: BackendId` 会自动吃到我方五值,不用改类型。文档和 `getBackendStatus` 的 model 说明要写清 ImgRouter。

---

## 九、文件清单(实施时按序)

### A. 新文件(从上游拷,generate.ts 拷完立刻改)

```
src/base64.ts
src/bytes.ts
src/bytes.test.ts
src/pool.ts
src/pool.test.ts
src/generate.ts          ← 拷完按 §4 扩
src/generate.test.ts     ← 拷完补 latent/imgrouter 用例(用现有 mock,不新造测试框架)
src/floor/chatObserver.ts
src/floor/missingImages.ts
src/floor/missingImages.test.ts
src/floor/slotHealth.ts
src/floor/slotHealth.test.ts
src/public/api.ts        ← 拷完按 §4 末段改 toPublicError / queued 判据
src/public/api.test.ts
src/public/register.ts
src/public/register.test.ts
src/public/types.ts
PUBLIC_API.md            ← 拷完补后端名单
```

### B. 外科手术

```
src/st/imageTagRegex.ts          placement 加 3;加 formatPromptText
src/st/imageTagRegex.test.ts     跟上游 placement/formatPromptText
src/st/images.ts                 加 list/probe;filename 注释改为「可带扩展名」
src/st/images.test.ts            跟上游 probe 用例
src/backends/nai.ts              只改 DEFAULT_UNDESIRED_CONTENT['nai-diffusion-5-full']
src/backends/nai.test.ts         只加「V5 Full 默认负面只排缺陷」;endpoints 字段保留
src/backends/vibeStore.ts        import @/base64,删私有函数
src/autoTag/prompt.ts            只改 §7 三处文案
src/floor/storage.ts             落盘改道 + sidecar + saveExternalImage + deleteImageFileOnly
src/floor/storage.test.ts        跟上游新用例,保留我方旧 extra 形状测试
src/floor/actionButton.ts        改用 chatObserver
src/floor/hydrate.ts             自愈;concurrency watch 不动
src/floor/Card.vue               generateImage + missingImages + 保留五路文案/历史
src/floor/lightbox.ts            可删 deletable 字段(onDelete 仍在)
src/pages/gallery/index.vue      整页换成上游
src/pages/gallery/index.test.ts  上游测试一起过来
src/index.ts                     registerPublicInterface
```

### C. 删除

```
src/pages/gallery/collect.ts     旧图库收集器,无引用后删
```

### D. 明确不动

```
src/state/settings.ts
src/autoTag/runner.ts
src/autoTag/notice.ts
src/backends/imgRouter.ts
src/backends/promptSections.ts
src/pages/backend/**
src/pages/settings/index.vue
src/pages/history/**
src/state/history.ts
package.json / manifest.json 的 version
README.md / architecture.md / DESIGN.md
```

---

## 十、风险

| 风险 | 回滚 |
|---|---|
| 旧 `user/files` 图不进新图库 | 楼层卡片仍显示;要看旧图去原聊天。不写迁移 |
| `generate.ts` 漏 ImgRouter/Latent | 卡片按钮变灰 / 公开接口 `not_configured`。§4 是硬门槛,漏了就是回归 |
| 图库删除留下破指针 | 卡片 HEAD 确认 404 后降级;网抖不落册(probe 返回 null 不标记) |
| 侧写 404 → 图库提示词空白 | 本聊天 extra 预填能兜;跨聊天老图(合入前生成)无侧写,提示词空是预期 |
| 自愈写 DOM 再唤醒 observer | observer **不**订 attributes;自愈一轮后 health=ok,停止 |
| 公开接口把 reactive 角色库递出去 | `clonePublic` + 冻结 api 对象,跟上游纪律 |
| 嵌套目录 `ST-BaiBai-Image-main/` | 合完后可删,不要 commit |

---

## 十一、验证(批准后实施时跑)

现有环境,不装新工具:

```
pnpm test
pnpm typecheck
```

重点人工看:

- Latent 出图仍走 flatten(请求体正向串含 `--- 正向提示词 ---`,Character Prompts 为空)
- ImgRouter 出图不进 NAI 闸门
- NAI 多站点切换后 url/key 镜像仍对
- 备用渠道 + 进度 toast 仍在
- `/narrator` 楼有卡片、正文没有裸 tag
- 图库按角色目录列出新图;删图后卡片变「图片文件已删除」而不是破图
- `globalThis.STBaiBaiImage.getBackendStatus()` 在 ImgRouter/Latent 下 `configured` 正确

---

## 十二、不在本轮

- 不 bump 版本号
- 不改 img-router-main
- 不 force push
- 不把嵌套上游目录加进 git
- 不重写 architecture.md
- 不把我方图库的「按角色筛选 / 搜索 / 批量删 extra」迁回上游图库(上游是目录浏览 + 只删文件)
