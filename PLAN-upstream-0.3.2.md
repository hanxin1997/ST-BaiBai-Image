# 计划:合入上游 ST-BaiBai-Image 0.3.2 快照

对照对象:`ST-BaiBai-Image-main/`(`package.json` 写 0.3.2)。我方:`main`,0.3.0,上一轮已合到上游 0.2.7(commit 40062d5)。

**本文件只是方案。未批准前不改 `src/`。**

---

## 已确认(用户拍板)

| 项 | 选择 |
|---|---|
| 破限词 | **必须同步**上游内置默认 |
| 我方功能 | **全部保留**:Latent / ImgRouter / NAI·Latent 多站点切换 / tag 备用渠道 / 进度提示 |
| 预填充 | **跟上游删掉**(见 §七) |
| 版本号 | **升到 0.3.2**,与上游对齐,上游再发版时红点才有意义(见 §九) |
| 「路人可入画 / 主角优先 / 人数按取景框」 | **推广到 ComfyUI 与 ImgRouter 的规范与思维链**(见 §八) |
| 新功能「世界书生图」 | 做(见 §十)。非 NAI 渠道合并成一串;开关开着时没有生图词的楼**什么都不做**;标题行保留;按哪种格式读由开关下的「世界书格式」选项(NAI / Anima)决定,不从内容猜;这个选项**只管怎么读**,出图走当前出图渠道 |
| 新渠道「Latent 原生 API」 | **新增**(见 §十一)。旧「Latent」渠道原样保留,不冒险 |
| 方形画幅 | 只给新渠道;其它渠道遇到方形按竖图出 |
| 新渠道的自动 tag 规范 | 照 `anima寻迹.json` 世界书的规则写一套专用的 |
| 新渠道的地址/Key | 只存一条 |

## 仍按默认处理(不同意请直接说)

| 项 | 默认 |
|---|---|
| ImgRouter 画幅锁 | 不加,恒 `auto` |
| 旧版单串 NAI 规范/思维链(`DEFAULT_NAI_SPEC` / `DEFAULT_NAI_THINKING`) | 不改。模型列表只剩 4.5/V5,这两份没有任何入口能走到 |

---

## 一、上游(上轮合到 0.2.7 之后)改了什么、合不合

| 上游改动 | 合? | 说明 |
|---|---|---|
| **破限词换成 NVWA 核心** | ✅ | 整段替换常量。留空的用户自动吃新默认;自定义过的不受影响(上游也没做迁移) |
| NAI 规范/思维链:**一次性无名角色可入画**、优先主角、人数按取景框算 | ✅ | `DEFAULT_NAI_V5_SPEC` / `DEFAULT_NAI_V5_THINKING` 整段替换。Latent 共用这两份,一起受益 |
| **NAI「生成自然语言」开关** + `{{#nl}}`/`{{^nl}}` 条件段 | ✅ | Latent 共用 NaiSettings + NaiPanel,开关自动各存一份 |
| **画幅方向锁**(自动/竖/横) | ✅ | NAI 渠道级、Latent 渠道级、ComfyUI 每套工作流;ImgRouter 恒 auto(见开头「仍按默认处理」) |
| **楼层图片显示大小**(小/中/大/铺满,默认中) | ✅ | 纯显示,不碰出图 |
| **出图信息随图记录**(画师串/vibe/采样参数,灯箱与图库可看) | ✅ | `GenerationMeta.backend` 扩到四值;Latent / ImgRouter 也写 meta |
| **单张「AI 重写提示词」**(编辑弹窗内,关窗不中断) | ✅ | 要嵌进我方渠道链(主→备用)与进度提示,**不能**用上游的单渠道重试 |
| 副 API 请求体固定带 `tool_choice: 'none'` | ✅ | 防第三方 fetch 拦截器改写;`excludeParams` 可删 |
| 悬浮菜单触屏改横排可折行 | ✅ | `card.css` 跟上游 |
| 删「预填充」 | ✅ | 见 §七 |

### 明确不合

| 上游改动 | 不合的理由 |
|---|---|
| **NAI 接入点重做**(`nep_*` id、内置不可删官方条、`effectiveNai()` 读取、`url/key` 降为存量字段) | 上游自己另做了一套多站点,和我方的 `ep_*` 站点库 + url/key 活值镜像**数据形状不兼容**。latent 没有官方地址,「内置官方条」对它不成立。换过去要迁移用户数据、重写 Latent 面板,正是「切换功能」的破坏点。**保留我方实现** |
| `settings.naiEndpointMigration.test.ts`、`generate.test.ts` 里 3 条接入点用例、NaiPanel 接入点那半 | 同上,测的是上游那套 |
| 删 Latent / ImgRouter / `SELECTABLE_BACKENDS` / 备用渠道 / 进度提示 / `promptSections` 分段 | 我方功能 |
| `history.ts` / `pages/history` / `pages/backend/index.vue` / `NaiArtistManager.vue` | 上游 diff 只是把我方的 latent/imgrouter/target 删掉 |
| 设置页「副 API」区块挪位置、下拉换 `BbiSelect` | 纯排版;我方这块多了备用渠道下拉,挪动会冲突 |
| `storage.ts` / `public/api.ts` 改回内联 `btoa` 分块 | 我方 `@/base64` 的 `bytesToBase64` 更好,上轮刻意抽的 |
| `vite.config.ts` 删嵌套目录排除、`shims-vue.d.ts` 删 `?raw`、`gallery/index.test.ts` 改 `readFileSync` | 我方现有写法保留(嵌套目录还在,必须排除) |
| `tsconfig.json` 把 `vite.config.ts` 加进 include | 会扩大 typecheck 范围,不是本轮目标 |
| `package.json` / `manifest.json` 版本 | 不照抄文件,只改版本号(§九) |
| `README.md` / `architecture.md` | 不主动改文档 |

---

## 二、四路后端在新功能上的口径(硬门槛)

上游原件只认 nai / comfyui。不扩就是 Latent / ImgRouter 回归。

| | NAI | Latent | ComfyUI | ImgRouter |
|---|---|---|---|---|
| 自然语言开关读哪 | `nai.naturalLanguage`(仅 4.5/V5) | `latent.naturalLanguage`(仅 4.5/V5) | 当前工作流 | `imgrouter.naturalLanguage`(已有) |
| `{{#nl}}` 条件段展开 | 规范 + 思维链 | 同 NAI | 规范 + 思维链 | **规范 + 思维链也展开**(与 Comfy 同口径,`{{nl}}` 宏照旧) |
| 画幅锁读哪 | `nai.orientationLock` | `latent.orientationLock` | 当前工作流 | 恒 `auto` |
| NAI 闸门 | 持槽 | 持槽 | 不持 | 不持 |
| `GenerationMeta` | 画师串/vibe/采样 | 同 NAI,`positive` 记**分段串**(实际发出去的) | simple 模式全文 + 采样 | `positive` = `imgRouterFullPrompt`,负面空,artist null,vibes [] |
| 历史标签 | 我方四值 `ImageBackend` 不变 | | | |

两个判据各只一处:

- `autoTagProfile()`(prompt.ts):`naiCharPrompts = naiProtocolBackend() && naiSupportsCharacterPrompts(naiProtocolConn().model)`;`nl` 按上表;`lockedSize` 取 `activeOrientationLock()`。
- `activeOrientationLock()`(settings.ts):按上表四路。

runner 收尾的「关自然语言就丢 nl」对四路一视同仁(ImgRouter / Comfy 关着时本来就不该发 nl,和上游 Comfy 口径一致)。

第五路「Latent 原生 API」(`latentapi`)的口径见 §十一:自然语言读 `latentApi.naturalLanguage`,画幅锁读 `latentApi.orientationLock`(多一个方形),不持 NAI 闸门,meta 记实际发出的整串。

## 三、文件清单

### A. 新文件(从上游原样拷)

```
src/generationMeta.ts            ← 拷完把 backend 联合扩成 'nai'|'latent'|'comfyui'|'imgrouter'
src/generationMeta.test.ts
src/autoTag/slotPlan.ts
src/autoTag/slotPlan.test.ts
src/floor/tagPlanState.ts
src/floor/tagPlanState.test.ts
src/floor/promptEditor.test.ts
src/state/settings.orientationDisplay.test.ts   ← 已查:不依赖接入点
```

### B. 外科手术

**`src/state/settings.ts`**
- `DEFAULT_JAILBREAK_PROMPT` 整段换成上游 NVWA 版
- `DEFAULT_NAI_V5_SPEC` / `DEFAULT_NAI_V5_THINKING` 整段换成上游版(含条件段与一次性角色规则)
- `NaiSettings` 加 `naturalLanguage` / `orientationLock`;`naiDefaults` 与 `normalizeNai` 补默认(latent 复用,自动带上)
- `ComfyWorkflowPreset` 加 `orientationLock`(new / normalize 两处)
- `UiPrefs` 加 `imageDisplaySize` + `IMAGE_DISPLAY_SIZES` / `imageDisplayMaxHeight`
- 新增 `ORIENTATION_LOCKS`、`activeOrientationLock()`(四路,见 §二)
- `AutoTagPrompts` 注释补条件段说明
- **不动**:站点库 / `SELECTABLE_BACKENDS` / `tagGenFallback` / `notifyProgress`(ImgRouter 两份默认按 §八 改文案)

**`src/backends/size.ts`**:加 `OrientationLock` / `normalizeOrientationLock` / `effectiveOrientation`

**`src/backends/comfyTemplates.ts`**:导出 `composePositive` / `composeNegative`,加 `comfySimpleParams`

**`src/backends/nai.ts`**
- 加 `naiArtistUsage`;`applyVibes` 返回 `{applied, skipped}`;`generateNaiImage` 返回 `{result, usage}`;加 `naiParamsSnapshot`
- `usage.positive` 调 `fullPositivePrompt(..., { characters, flatten })`,与请求体**同一次拼装**
- **`flatten` / `FullPositiveOpts` / `singleSubjectTag` / `promptSections` 一行不动**

**`src/generate.ts`**
- `GenerateOutput` 加 `size` / `meta`;画幅锁在这里统一生效
- 现有 `dispatchGenerate` 拆成 `runNai` / `runImgRouter` / `runComfy` 三个,各自返回 `{result, meta}`(保函数 ≤50 行)
- `backendStatus` / `decideSeed` / `isNaiProtocol` / 闸门逻辑不动

**`src/autoTag/prompt.ts`**
- 加 `autoTagProfile()` / `expandNlSections()`;`buildAutoTagMessages` 加 `taskNote` / `profile` 两个尾参(调用方只有 runner 与测试)
- 三份规范 + 三份思维链都过 `expandNlSections`;`resolveNlMacro` 保留(comfy / imgrouter 共用)
- NAI 关自然语言时:示例 JSON 去 nl、`contentRule` / `libraryReferenceRule` / `newCharacterNlRule` / 服装那句按上游分两版
- `sizeRule` 按 `lockedSize` 三版;示例 `size` 填锁定值
- `naiProtocolBackend()` / `naiProtocolConn()` / imgrouter 分支保留;预填充按 §七 删

**`src/autoTag/runner.ts`**(冲突最重的一处)

在**我方**渠道链 `requestImagePlan` 上加单槽重写,不换成上游的单渠道循环:

- `RunOptions.slot?: { seq }`;开跑快照 `slotRawTag`,不存在即放弃
- slot:绕过「已有 tag」闸门;分析基底剔 tag;`entriesBefore = charTagsBeforeFloor(floor + 1)`;`min/maxImages = 1`;传 `buildSlotTaskNote`
- `profile = autoTagProfile()` 开跑快照一次,写协议、`parse` 验收、收尾共用
- `parse`:建档必带 nl 的校验改成 `!slot && profile.naiCharPrompts && profile.nl`
- 收尾:`!profile.nl` 丢 nl;`profile.lockedSize` 改记 size;slot 不落 changes、空 images 保持原样
- 写回:slot 走 `replaceImageTagAt` + CAS,不传 extraUpdate;force 出图;失败只撤自己那枚标记(`consumeAutoGenerate`)
- `describeSource` / `describeAttempt` 给 slot 带「重写第 N 张」字样(请求历史与进度提示都看得出是重写);备用渠道照常生效
- 局部变量 `slot`(锁 key)改名 `runKey`,让出名字给 `opts.slot`
- 导出 `requestSlotTag` / `cancelFloorTags`
- 新增逻辑抽成小函数(快照校验 / 收尾裁剪 / slot 写回);`runForFloor` 本身本来就超 50 行,本轮不整体拆(见风险)

**`src/floor/`**
- `storage.ts`:`meta` 进 entry 与侧写(v: 1 → 1|2);`saveImageResult` / `saveExternalImage` 加尾参 `meta?`;**保留** `bytesToBase64`
- `promptEditor.ts` / `PromptEditor.vue`:合上游 AI 重写按钮、续上、`nextEditorState`、锁定时方向按钮禁用
- `Card.vue`:合 `planning` 遮罩/取消、`effectiveSize`、`displayMaxHeight`、灯箱 meta、`saveImageResult(..., meta)`;**保留**四路 `pendingHint` / `activeBackend()` / `isNaiProtocol` 判队列
- `card.css`:整文件跟上游(只有显示大小封顶与触屏横排)
- `hydrate.ts`:只加 `clearAllTagPlans()`;**concurrency watch 保持我方写法**(跟随 latent/nai)

**`src/api/client.ts`**:`buildRequestBody` 加 `tool_choice: 'none'` + 注释;`requestViaMainApi` 注释补一句;prefill 丢弃逻辑删掉(§七)

**`src/public/api.ts`**:`saveToGallery` 传 `output.size` 与 `output.meta`;`ImgRouterError` / `isNaiProtocol` / `bytesToBase64` 保留

**`src/pages/gallery/index.vue`**:`renderPrompt` 追加 meta(上游原样)

**`src/pages/settings/index.vue`**:加「楼层图片显示大小」下拉;`NL_SECTION_MACROS` 挂到 NAI / ComfyUI / **ImgRouter** 的规范与思维链;hint 文案跟上游;删预填充两处(§七);加「世界书生图」开关(§十);备用渠道、进度提示、`SELECTABLE_BACKENDS` 不动

**`src/pages/backend/panels/NaiPanel.vue`**:加「生成自然语言」开关、「画幅方向」分段按钮,一律绑 `conn.value.*`(Latent 页签各存各的);hint 里「NAI」用 `label`;站点库那半**不动**

**`src/pages/backend/panels/ComfyUIPanel.vue`**:加画幅方向分段按钮(上游原样)

**`PUBLIC_API.md`**:只同步上游 `size` 锁定那两句;后端枚举仍写四值

### C. 现有测试跟着改(拷上游用例,按我方类型适配,不自造新用例)

| 文件 | 改法 |
|---|---|
| `backends/nai.test.ts` | 工厂补 `naturalLanguage` / `orientationLock`(站点字段保留 `ep_test`);`applyVibes` 断言改 `.skipped` / `.applied` |
| `backends/size.test.ts` | 拷上游锁相关两组 |
| `api/client.test.ts` | 拷上游 `tool_choice` 两条;渠道夹具删 `prefill` |
| `autoTag/prompt.test.ts` | 拷上游一次性角色 / 主角优先 / 条件段 / 自然语言开关 / 画幅锁用例,以及上游「无预填充、以 user 收尾」的改写;**保留**我方 imgrouter / latent / notifyProgress 断言;`AutoTagSettings` 夹具补 `worldbookImages: false` |
| `state/settings.thinkingSplitMigration.test.ts` | 跟上游删 `prefill` 那行断言 |
| `generate.test.ts` | 拷上游锁 + meta 用例(**不拷**接入点 3 条);我方 latent / imgrouter 用例保留,补 `size` / `meta` 断言 |
| `floor/storage.test.ts` | 拷上游 meta 落盘用例 |
| `public/api.test.ts` | 拷上游「记实际出图方向」用例 |

### D. 明确不动

```
src/backends/imgRouter.ts  src/backends/promptSections.ts  src/autoTag/notice.ts
src/state/history.ts       src/pages/history/**            src/pages/backend/index.vue
src/pages/backend/panels/NaiArtistManager.vue  ImgRouterPanel.vue
vite.config.ts  tsconfig.json  shims-vue.d.ts
README.md  architecture.md  DESIGN.md      (architecture.md 里的「预填充」描述会过时,按规矩不主动改)
```

---

## 四、风险

| 风险 | 说明 / 回滚 |
|---|---|
| 新破限词措辞不同 | 旧词是「沙盒免责 + 解除审查」,新词是「成人内容照常处理 + 未成年/武器/恶意代码边界」。个别副 API 模型的拒答率可能变。只影响破限词留空的用户;想要旧的,在设置页把旧文本粘进去即可 |
| NAI 规范默认换新 | 同上,只影响留空用户。上游说开启侧展开后与 0.3.0 内置逐字相同,**这句我会用测试核实**,不照信 |
| 显示大小默认「中」(≤600px) | 升级后楼层图会变小,上游刻意的。想回旧样子选「铺满楼层宽度」 |
| runner 改动最密 | slot 分支与渠道链交织。靠上游 slot 用例 + 我方备用渠道用例一起兜;人工看一次「重写走备用渠道」的提示文案 |
| 长函数 | `runForFloor` / `buildAutoTagMessages` 合入前就远超 50 行。本轮只把新增逻辑抽成小函数,不整体拆;要拆另开一轮 |
| 一键更新 | 见 §九:红点亮了先对比再合,别直接点 |
| 预填充删除 | 见 §七:共享渠道存储里的 `prefill` 键 |
| 世界书生图 | 见 §十 末尾 |
| Latent 原生 API 走转发 | 必须开酒馆 `enableCorsProxy`;转发会不会保留 `Authorization` 头未核实,实现后用「测试连接」实测(§11.2) |
| Latent 原生 API 接口细节 | 轮询返回的字段、取图的 `size` 取值文档没写全,缺材料见 §十二 |
| 2000 字符上限 | 世界书要求 Description 写 6–12 句,多人画面容易超;超了报错,不截断 |
| 世界书内容取舍 | 见 §11.7「刻意不搬」 |
| 两套多站点长期分叉 | 以后上游再改 `NaiPanel` / `settings.nai` 时,冲突会越来越多。本轮不解决,记在这里 |

---

## 五、验证(批准后实施时跑)

```
pnpm test
pnpm typecheck
pnpm build        # 版本号靠 build 注入,不重建 dist 版本号不生效
```

人工看:

- 世界书生图:用你给的实样(夏洛特那条),NAI 渠道下转成一个 Base + 1 个角色、位置 C3;ComfyUI 渠道下合成一串;标题行还在;副 API 请求历史里没有新记录
- ComfyUI / ImgRouter 规范与思维链(设置页「查看默认」)不再出现「人数必须与正文一致」「有名有姓」「二选一」
- 请求末尾不再有 assistant 预填充;渠道弹窗里没有「发送预填充」
- 插件设置页显示版本 0.3.2,更新红点熄灭
- 世界书生图:「世界书格式」选 Anima 时,用 Anima 实样(Gamma 那条)转出 Base + 2 个角色 + 自然语言、方形;选 NAI 时同一条不转换并给出格式不符的提示
- Latent 原生 API:测试连接通过;出一张图,请求体是 `Scene:… Char1:… Description:…` 整串、resolution 对;落盘成功;旧「Latent」页签照旧能出图

- 设置页破限词「查看默认」显示 NVWA 版;请求历史里第一条 system 是新词
- Latent 出图:正向串仍是分段格式,Character Prompts 为空;灯箱「出图信息」里正向词是分段串
- Latent 页签的「生成自然语言」/「画幅方向」与 NAI 页签各存各的
- ImgRouter 出图不进 NAI 闸门,灯箱有 meta
- NAI 多站点切换后 url/key 镜像仍对
- 备用渠道 + 进度提示仍在;「AI 重写提示词」失败时也会切备用
- NAI 关自然语言:请求里协议与示例没有 nl
- 锁横屏:自动 tag 协议改口、卡片占位按横屏

---

## 六、不在本轮

- 不改 README / architecture.md
- 不换上游接入点方案
- 不给世界书生图做「隐藏流式原文」的显示正则(见 §十 风险)
- 不新写测试文件(只拷上游已有用例并适配)
- 不 commit、不 push

---

## 七、删预填充(跟上游)

| 位置 | 改法 |
|---|---|
| `state/settings.ts` | 删 `ApiChannel.prefill` 及 `normalizeChannel` / `newChannel` 两处;删 `DEFAULT_PREFILL_PROMPT`;删 `AutoTagPrompts.prefill` 及默认值 / 归一化 |
| `autoTag/prompt.ts` | 删末尾 assistant 预填充;消息以 user 收尾 |
| `api/client.ts` | 删 `outMessages` 截断,直接发 `messages` |
| `pages/settings/index.vue` | 删 `TAG_PROMPT_METAS` 的「预填充」条、渠道弹窗的「发送预填充」开关 |
| `st/context.ts` 的 `generateRaw.prefill?` | **不动**,那是 ST 自己的参数类型 |

风险:渠道列表与柏宝书**共享存储**,`normalizeChannel` 只留认识的字段。删掉之后,在柏宝绘这边编辑过渠道,写回的数据里就不再带 `prefill` 键。柏宝书若也读这个键,会回落到它自己的默认值。我看不到柏宝书代码,无法确认它读不读。

---

## 八、「路人可入画 / 主角优先 / 人数按取景框」推广到 ComfyUI 与 ImgRouter

现状:固定协议第 6、7 条(prompt.ts,四路共用)已经是新口径;但 ComfyUI 与 ImgRouter 的**规范和思维链**还写着「人数必须与正文一致」「逐个列出在场且有名有姓的角色」「每个在场角色各一行」「每个在场正式角色都能二选一」,两边自相矛盾。

改法(四份默认文本:`DEFAULT_COMFY_SPEC` / `DEFAULT_COMFY_THINKING` / `DEFAULT_IMGROUTER_SPEC` / `DEFAULT_IMGROUTER_THINKING`;两对同步改,ImgRouter 只保留括号不转义、无 negative 两处差异):

**规范**
- 「4. 剧情事实」换成 NAI V5 第 4 条的中文对应:取景突出玩家主角/主要角色;不贡献于焦点的在场者可以留在镜头外;核心互动需要的无名参与者照常入画,缺档不是裁掉他的理由;人数 tag 只数取景框内可见的人
- 「多人画面」加两条:无名一次性角色入画时,同样要有发色/瞳色等可绑定的硬特征,只是不进档案、绝不编人名;人群不逐个写,作为一个整体词留在串里,拿不准按一团处理

**思维链**(照 NAI V5 那份的改法,换成单串 tag 的说法)
- B:清点「谁在场」而非「谁有档案」,三类标记(已建档 / 本次建档 / 一次性);清点名单不是入画名单;人群一行
- C:只给已建档/本次建档的角色立服装时间线;一次性角色不占行
- E:加「优先突出玩家主角或主要角色」「先定主体与核心互动,再定谁入镜」两条
- 第二层:「角色行(每个在场角色各一行)」→「每个本图可见的个体各一行」;人物槽只数取景框内的人
- 第三层:「二选一」→「三选一」;加取景自查一条

只改措辞,槽位结构与其余条款不动。只影响这两份留空(用内置默认)的用户。`prompt.test.ts` 里若有锁旧措辞的 ComfyUI 断言,跟着改,不新增断言。

---

## 九、版本号升到 0.3.2

- `package.json` 的 `version` 改 `0.3.2`,跑 `node scripts/sync-version.mjs` 同步 `manifest.json`(`version` 与 `js` 的 `?ver=`)
- 运行时版本号是 build 时由 `__BBI_VERSION__` 注入的,所以要 `pnpm build` 重建 `dist/` 才生效
- 效果:更新检测拿到的上游版本号(0.3.2)和本地一样,红点熄灭;上游发 0.3.3 时才会再亮

⚠ 设置页「一键更新」调的是 ST 的 `/api/extensions/update`,对插件目录做 git pull,拉的是**你安装时的那个远端**。如果当初是从上游仓库装的,点一键更新会把本 fork 的改动拉没。红点亮了的正确用法是:把新快照拷进嵌套目录,再走一轮这样的合并,**不要直接点更新**。

---

## 十、新功能:世界书生图

主 API 按世界书要求,已经把生图词写进了正文:

```
【夏洛特震惊俯瞰考场】
 image###Scene Composition:best quality, 1girl, …, from side;Character 1 Prompt:charlotte_belew, …, open mouth|centers:C3;Character 1 UC:;###
```

开关打开后直接把 `image###…###` 换成 `<bbi_image>` 卡片并出图,省掉一次副 API 请求。

### 10.1 设置

- `AutoTagSettings.worldbookImages: boolean`,默认 `false`;`normalize` 缺字段回落 `false`
- `AutoTagSettings.worldbookFormat: 'nai' | 'anima'`,默认 `'nai'`;认不出的值回落默认
- 设置页:「世界书生图」开关下面紧跟一个两档切换「世界书格式:NAI / Anima」,开关关着时不显示。它只决定按哪种格式读生图词;出图仍走「当前出图渠道」
- 设置页「自动生成 tag」折叠区,紧跟「自动生成 tag」开关下面:**世界书生图**。hint:「正文里已有世界书写好的 `image###…###` 生图词时,直接转成图片卡片并出图,不再请求副 API。打开后,没有生图词的楼不会自动生成 tag;手动按钮照常可用。」

### 10.2 解析(新文件 `src/autoTag/worldbookImage.ts`,纯函数,无宿主依赖)

- 块:`image###` 到下一个 `###` 为止;外面包着 `<image>…</image>` 也认,连壳一起替换。你的实样没有壳,两种都支持
- 按哪种格式读,**只看设置里的「世界书格式」选项**,不从生图词内容猜。字段一律按**键名**切,不按分号/句号切(内容里本来就有分号和句号),键名前后的空白与换行都容忍:

  | 选项 | 键 | 落到 |
  |---|---|---|
  | NAI | `Scene Composition` / `Character N Prompt`(可带 `\|centers:`)/ `Character N UC` | Base / 第 N 个角色 / 该角色负面 |
  | Anima(`anima寻迹`) | `size` / `Scene` / `CharN` / `Description` | 画幅 / Base / 第 N 个角色 / 自然语言 |

  只认所选格式的键。某一块按所选格式一个键都对不上 → 这一块保留原文不转换,并提示一次「生图词格式与『世界书格式』设置不符」。旧格式的老楼层要转换,把选项切回去再点手动按钮即可。字段值末尾充当分隔的句号去掉;`Description` 是句子,句号保留
- `Character N Prompt` 末尾的 `|centers:C3` 拆出来当位置(网格标签 A–E × 1–5);多个 center 只取第一个
- 角色名:格式里没有,统一记 `角色 1`、`角色 2`(只用于卡片展示,不编人名)
- 方向:Anima 版的 `size:WxH` 按宽高比换算:宽>高 → landscape,高>宽 → portrait,相等 → **square**(只有新渠道真出方图,其它渠道按竖图出,见 §11.6);NAI 版没写尺寸 → portrait。渠道锁了方向就按锁出图(§二)
- tag 原样透传(下划线写法也不改写)
- 某块内容含 `<bbi_image>` / `<tag>` 等子标签字面量 → 这一块跳过保留原文,`console.warn`
- 键名、分隔符、网格表都写成命名常量
- 标题行 `【…】` 不动,原样留在正文

### 10.3 转换时按当前渠道定形

| 渠道 | 结果 |
|---|---|
| NAI / Latent(4.5/V5) | Base = Scene Composition;每个角色进 `characters[]`,带 `center` / `uc` |
| ComfyUI | Scene Composition + 各角色 Prompt 按序用 `, ` 拼成一条 tag;各角色 UC 拼进 `negative` |
| ImgRouter | 同 ComfyUI 拼 tag;UC 丢弃(ImgRouter 没有负面输入,与现有口径一致) |
| Latent 原生 API | 结构化保留:Base = Scene,`characters[]` = 各 Char,`nl` = Description;出图时再按 Anima 格式打包(§11.4) |

Anima 版的 `Description` 在所有渠道都进 `nl`(NAI 下是 Base 的自然语言)。

只在转换那一刻按渠道定形。之后切渠道,已转好的 tag 不会回头重写(正文 tag 原文是真源),要改就用编辑弹窗或「AI 重写提示词」。

### 10.4 触发(`autoTag/runner.ts`)

同一个最终渲染钩子,同一套排除名单 / 剧情楼判据 / 「已有 bbi_image 就跳过」闸门。

| 情形 | 行为 |
|---|---|
| 开关开,正文有生图词 | 转换 → CAS 写回(同 `applyMessageText`)→ 每个新槽位挂自动出图标记 → **不请求副 API**。不看「写入 tag 后自动生成图片」那个开关:读到生图词就是要出图 |
| 开关开,没有生图词 | 什么都不做(你选的)。不回落副 API 自动 tag |
| 开关关 | 与现在完全一样 |
| 手动按钮(调色盘),非 replace | 开关开且有生图词 → 直接转换;否则照旧走副 API |
| 手动「重新生成」(replace) | 照旧走副 API |

`runForFloor` 里的闸门顺序要调:排除名单与剧情楼判据先过,然后是世界书分支,最后才是 `autoTag.enabled`。否则在「自动生成 tag」关着时,世界书分支根本走不到。

世界书分支单独写成一个函数(写回 + 挂标记 + toast,≤50 行),不往 `runForFloor` 里塞。

### 10.5 角色位置与分角色负面(协议扩字段)

- `ImageCharacterPrompt` 加两个**可选**字段:`center?: string`(网格标签)、`uc?: string`
- `parseImageTagContent` / `serializeImageTag`:`<characters>` JSON 里有就读写,没有就不写。**旧 tag 原文逐字节不变,promptHash 不变**
- 编辑弹窗:复制 / 比较角色时带上这两个字段,不让它们被编辑一次就丢;本轮不加编辑控件
- `formatPromptText`:角色段有 `uc` 时多一行 `UC: …`
- `nai.ts` `buildNaiParameters`:
  - 有 `center` 的角色按网格换算坐标:列 A–E → x 0.1/0.3/0.5/0.7/0.9,行 1–5 → y 0.1/0.3/0.5/0.7/0.9(C3 = 正中)
  - 有任一角色带 `center` 才把 `use_coords` 置 `true`(params 与 `v4_prompt` 两处);都没有时请求体与现在**逐字节相同**
  - `uc` 进 `v4_negative_prompt` 对应角色的 `char_caption`(现在恒为空串)
- Latent(flatten)装不下位置和分角色负面,这两项在 Latent 下不生效

### 10.6 风险

| 风险 | 说明 |
|---|---|
| 网格换算是我按 NAI 官方 5×5 网格的理解写的 | 没有拿真请求核对过。位置不对时只需改一张常量表 |
| 世界书路径不经副 API | **不建档、不更新角色外貌库**。外貌全靠世界书自己写进 tag |
| 质量词可能重复 | Scene Composition 自带 `best quality`,NAI 渠道还会再拼一遍质量词与画师串。本轮不去重 |
| 流式期间原文可见 | 生成过程中正文里会短暂显示 `image###…###` 原文,渲染完成才变成卡片 |
| 主 API 下一轮看到的上下文 | 转换后正文里只剩 `<bbi_image>`,提示词侧被隐藏规则剔除,主 API 看不到自己上一轮的生图词。这是现有隐藏规则的既定行为 |
| 无新测试 | 按你的规矩不新写测试文件。解析函数靠 typecheck + 用实样手动跑一遍验证 |

---

## 十一、新渠道「Latent 原生 API」

旧「Latent」渠道(NAI 协议 + 分段串)**一行不改**;它只跟着本轮已批准的 NAI 共用改动走(自然语言开关、画幅锁)。新渠道是第五路,id `latentapi`,页签名「Latent 原生 API」。

### 11.1 接口(按你给的文档)

| 步骤 | 请求 |
|---|---|
| 排队 | `POST {url}/api/generate`,头 `Authorization: Bearer <key>`、`Idempotency-Key: <uuid>`;返回 202 + 任务 id |
| 轮询 | `GET {url}/api/generate/{id}`,直到 status 离开 queued / leased / running |
| 取图 | `GET {url}/api/media/{artworkId}?size=…`,同一个 key |

参数照文档:`prompt` 1–2000 字符;`negativePrompt` 0–2000(**站点不加默认负面**);`seed` 0 ~ 2^53-1;`resolution` = `square`(1024×1024)/ `portrait`(920×1536)/ `landscape`(1536×920);`steps` 8–12;`sampler` = euler / res_multistep / er_sde;`scheduler` = sgm_uniform / beta / beta57 / linear_quadratic。

### 11.2 必须走酒馆转发

我用不带 key 的 CORS 预检实测了 `https://latent.moe/api/generate`:返回 204,但**没有** `Access-Control-Allow-Origin` 头 → 浏览器直连会被拦。

所以三步请求都走酒馆自带的 CORS 转发(`/proxy/<地址>`)。代价:
- 要在酒馆 `config.yaml` 里打开 `enableCorsProxy: true` 并重启酒馆。这条是新渠道能用的前提
- key 经过你自己的酒馆服务器转给 latent.moe,不经第三方
- 转发会不会原样保留 `Authorization` / `Idempotency-Key` 头,我在本地没法核实,实现后用面板「测试连接」实测;没开转发时面板给明确提示

### 11.3 设置(新增 `settings.latentApi`,不碰 `settings.latent`)

| 字段 | 默认 | 说明 |
|---|---|---|
| `url` | `https://latent.moe` | |
| `key` | 空 | 只存一条 |
| `positivePrefix` | `masterpiece, best quality, score_7` | 世界书「官方参数备忘」里的正向前缀,**去掉了 `safe`**:分级标签由 Scene 写,前缀里固定写 safe 会和 nsfw/explicit 打架 |
| `negativePrompt` | `worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration` | 世界书给的官方负向。站点不加默认负面,所以必须由我们发 |
| `steps` / `sampler` / `scheduler` | 8 / euler / sgm_uniform | 文档默认值 |
| `seed` | 0 = 随机 | |
| `naturalLanguage` | 开 | 管 Description 写不写 |
| `orientationLock` | auto | 可选 自动 / 竖 / 横 / **方** |

面板 `LatentApiPanel.vue`:地址、Key(可显示/隐藏)、测试连接、使用此渠道、正向前缀、负面、步数/采样器/调度器、种子、自然语言开关、画幅方向、一行「需要开 enableCorsProxy」的说明。

### 11.4 出图(新文件 `src/backends/latentApi.ts`)

- 打包成世界书那套格式(`size` 不进串,它走 `resolution`):
  `Scene:<正向前缀>, <Base tag>. Char1:<角色1 tag>. Char2:<…>. Description:<nl>`
  —— 没有角色就没有 Char 段,没有 nl 就没有 Description 段
- 角色 tag 里 NAI 专用的 `source#` / `target#` / `mutual#` 前缀去掉(旧 NAI tag 换到本渠道时会带着它们)
- `resolution`:按 tag 的方向 portrait / landscape / square;渠道锁了就按锁
- 整串超过 2000 字符 → 报错「提示词 N 字,超过 Latent 上限 2000,请在编辑弹窗里删减」,**不偷偷截断**
- 轮询:每 2 秒一次,10 分钟超时;取消时停止轮询(已排队的任务在站点上仍会跑完,图落在你的私人作品里)
- 不进 NAI 闸门(排队在站点那边);限流 429 / 5xx 本轮不自动重试,只给明确报错
- 每次出图一个新的 `Idempotency-Key`
- 取图不带 `size` 参数,拿 PNG 原图(实测,见 §十二)
- `GenerationMeta`:backend `latentapi`,model 固定记 `Anima-2.9B-int8-turbo`,positive = 实际发出的整串,negative = 渠道负面,宽高取任务返回的 `width`/`height`,params 记 steps / sampler / scheduler

### 11.5 第五路要接线的地方

| 位置 | 改法 |
|---|---|
| `BackendId` / `BACKENDS` / `SELECTABLE_BACKENDS` | 加 `latentapi`(标签「Latent 原生 API」);渠道页签与设置页下拉自动带上 |
| `history.ts` 的 `ImageBackend`、`pages/history` 的 `BACKEND_LABELS` | 加一值 |
| `GenerationMeta.backend` | 加一值 |
| `generate.ts` | `backendStatus`(url + key)、`decideSeed`、分派 `runLatentApi` |
| `Card.vue` | 未配置提示一句 |
| `public/api.ts` / `types.ts` / `PUBLIC_API.md` | `toPublicError` 认 `LatentApiError`;后端枚举与 model 说明补一值 |
| `pages/backend/index.vue` | 面板表加一项 |

### 11.6 方形画幅(只给新渠道)

- `Orientation` 加 `square`;`normalizeOrientation` 认它
- 其它渠道的 `pickSize` 遇到 square **按竖图那格出**:现有 tag 一个都不会变样
- 画幅锁选项:NAI / ComfyUI 面板仍是 自动/竖/横 三档;新渠道四档
- 自动 tag 协议的 size 规则:只有当前渠道是新渠道时才允许填 `square`
- 编辑弹窗:新渠道下才显示「方形」按钮;卡片无图占位按 1:1

### 11.7 自动 tag 规范(照 `anima寻迹.json` 写)

只影响新渠道下「手动生成 tag」与「AI 重写提示词」两个入口(世界书生图开着时自动流程不经过它)。

- 设置页新增一对可编辑提示词「Latent 原生 API 规范 / 思维链」(`latentApiSpec` / `latentApiThinking`),留空回落内置默认
- 协议形态沿用 NAI 那套 Base + `characters[]`,这样 runner、解析、角色库、编辑弹窗都不用另起一套;区别:**只有 Base 写 nl(= Description),角色不写 nl**;size 可填 square

内置默认从世界书提炼(只搬「怎么写画面」,世界书里关于输出 `<image>` 块、配图数量、插入位置的部分由插件自己的协议负责,不搬):

| 世界书条目 | 进规范 / 思维链的内容 |
|---|---|
| 标签规范 | 全小写、空格不用下划线;Scene 先写人数;**分级标签 safe/sensitive/nsfw/explicit 必须写进 Scene**;场景由大到小、由静到动、由远及近,光影紧跟场景;提示词越详细越好 |
| 规范 · Char 四要素 | 外貌 / 着装(每件带颜色、裙袜外套带长度)/ 表情(克制自然,禁止夸张颜艺)/ 动作(整体体位、左右手分写、支撑物) |
| 规范 · 视线 | **每个 Char 必写视线标签**,不写 = 模型默认看镜头;第三人称禁止 looking at viewer |
| 构图决策 | pov 优先(互动/对话);**有肢体接触时观众肢体必须入镜**(pov hands / viewer's shoulder),不写「搂住看不见的脖子」;景别、机位、留边;姿势必须有支撑点;光影写来源→照亮面→阴影 |
| 规范 · 场景选择 | 读完整段再构图,因果场景画完整;**只画完成态**,禁止 reaching / about to |
| 规范 · 比例匹配 | 正文没写就不加夸大身材与暴露服装 |
| 格式 · 尺寸 | 判定顺序:≥2 人并排 / 远景 → 横;近景半身 / 蹲坐 → 方;其余 → 竖 |
| 锚点 | 对应插件已有机制:L0 → 角色固定外貌库照抄;L1 → 服装时间线与场景连续;L2 → 单图当场填 |
| 清理规则 | 去重复、去不可见、去语义重复(留更具体的)、去互相矛盾 |
| 规范 · Description | 英文,以画面里看得见的对象为主语,写空间关系、光影、动态、情绪、材质;6–12 句;并要求 **Scene + Char + Description 合计控制在约 1800 字符内**(给前缀留余量,对上 2000 上限) |

**刻意不搬**:
- 「年龄阶段与外貌对应」里儿童 / 青少年的胸部、臀部发育标签,以及示例里把未成年设定与性内容放在一起的条目。改为一条硬规则:**sensitive / nsfw / explicit 只用于明确成年的角色,不与 child / adolescent / teenager 等描述同时出现**(与破限词里的未成年人保护一致)
- 年龄段里与性无关的部分**照搬**:青涩 / 成熟 / 苍老面容写法、身高与头身比、气质、家人共享面部特征、「身份必须匹配面容」「年龄差用成熟度体现」;成年阶段的身材描述照搬
- 标签权重 `(tag:1.5)`:自动 tag 协议本来就不写权重
- 角色名写法:世界书说「名字, 作品名」分开写,但它自己的示例又用 `name (series)`。插件的角色库 fandom 字段是各渠道共用的一份,本渠道**照抄库里的写法**,不另起一种

---

## 十二、接口实测结果(用你给的临时 Key 跑通一次)

| 项 | 实测 |
|---|---|
| 排队 | 202,返回整份任务对象:`id`、`status:"queued"`、`queuePosition`、`seed`、`width`/`height`、`artworkId:null`、`errorCode:null` |
| 轮询 | `status` 依次 queued → running → **succeeded**;成功时 `artworkId` 有值、`progress:100`。失败时的 status 值没遇到:除 queued / leased / running / succeeded 以外一律按失败,报错带 `errorCode` |
| 取图 | **不带 `size` → PNG 原图**(1024×1024,约 900KB,无损);`size=preview` → 同尺寸的有损 webp(约 60KB)。用不带 size 的 PNG,不需要格式转换 |
| 验证 Key | 不带 Key 查任务 → 401 `{"error":"unauthorized"}`;带正确 Key 查不存在的任务 → 404 `{"error":"not_found"}`。「测试连接」就用这个判断 |
| 错误返回 | `{"error":"…"}` |
| 跨域 | 实际响应同样没有 `Access-Control-Allow-Origin`,确认必须走酒馆转发 |
| 尺寸 | 任务返回的 `width`/`height` 就是实际出图尺寸,meta 直接记它 |
