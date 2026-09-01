# 计划:自定义提示词新增 ImgRouter 专属两条(规范 + 思维链)

## 决策(已确认)

| 项 | 选择 |
|---|---|
| 新增条目 | **两条**:`imgRouterSpec`(ImgRouter 规范)+ `imgRouterThinking`(ImgRouter 思维链) |
| 留空时的内置默认 | **另写一份 ImgRouter 专属默认**(`DEFAULT_IMGROUTER_SPEC` / `DEFAULT_IMGROUTER_THINKING`),不再回落 comfy 那份 |
| `{{nl}}` 宏展开 | 继续复用 `DEFAULT_COMFY_NL_SPEC`(内容与后端无关,只讲 nl 怎么写;再复制一份纯属制造漂移) |
| 存量 `comfySpec` 迁移 | **不迁**,ImgRouter 两格留空回落新默认(与 thinkingSplit 迁移里 `naiV5Thinking` 留空同口径) |

## 现状(动手前核对过的事实)

- `prompt.ts:57` 把 `comfyui` 与 `imgrouter` 合在同一分支取 `prompts.comfySpec`;`prompt.ts:93` 的思维链更是「非 NAI 系一律 `comfyThinking`」。
- 设置页 `TAG_PROMPT_METAS`(`settings/index.vue:127-175`)只有 6 条:破限词、NAI 规范/思维链、ComfyUI 规范/思维链、预填充。ImgRouter 无入口。
- `negativeOn` 只由 `activeComfyPreset()` 决定,而 `comfyPreset` 仅在 `defaultBackend === 'comfyui'` 时非空 ⇒ **ImgRouter 路径下 `negativeOn` 恒为 false**,协议里永远没有 `negative` 键。
- ImgRouter 出图是 `imgRouterFullPrompt()` 把「质量词 + tag + nl」拼成一条纯文本 POST 给上游图像 API(`imgRouter.ts:85`),既无负面输入也无权重语法。

## ImgRouter 专属默认与 ComfyUI 那份的差异(只有这四处)

| # | ComfyUI 那份 | ImgRouter 那份 |
|---|---|---|
| 1 | 标题「【ComfyUI 提示词规范】」+「会被直接填入 ComfyUI 工作流」 | 「【ImgRouter 提示词规范】」+「会被拼成一整条正向提示词发给 ImgRouter 转发的上游生图 API」 |
| 2 | 同人身份 tag 要求写 `character name \(copyright name\)`,并额外交代「JSON 里写双反斜杠」 | **不转义**,写 `character name (copyright name)`(与 NAI 那份同口径)。ComfyUI 转义是为了躲它自己的权重语法;ImgRouter 把提示词原文转发,反斜杠会当字面量漏进提示词 |
| 3 | 质量词一律不写 | 同样不写,但注明「质量词由渠道设置自动前置」;并注明「ImgRouter 无负面输入,负面词写了也不生效」 |
| 4 | 思维链第三层有一条「若本图协议含 negative 键…逐词自查」 | **删掉该条**(ImgRouter 永远拿不到 negative 键,留着是纯噪音);第三层身份 tag 自查同步去掉「括号已转义」 |

其余全部逐字沿用 comfy 那份(tag 排序、表情/视线词表、多人绑定、肤色禁令、画面补全四类、画幅方向、三层思考结构)——那些是模型侧通用规则,与后端无关。

## 改动清单(4 个文件)

### 1. `src/state/settings.ts`

- 新增 `export const DEFAULT_IMGROUTER_SPEC`(紧跟 `DEFAULT_COMFY_NL_SPEC` 之后)与 `export const DEFAULT_IMGROUTER_THINKING`(紧跟 `DEFAULT_COMFY_THINKING` 之后),按上表四处差异落地,文件头注释写明「与 comfy 那份的差异只有这四处,改一份时对照另一份」。
- `DEFAULT_COMFY_NL_SPEC` 的注释补一句:该宏内容被 comfy 与 imgrouter 两份规范共用。
- `AutoTagPrompts` 加两个键(带注释,说明 `{{nl}}` 宏行为与配对关系):
  ```ts
  imgRouterSpec: string;
  imgRouterThinking: string;
  ```
- `defaults()`(约 1214 行)`prompts` 里补 `imgRouterSpec: ''`、`imgRouterThinking: ''`。
- `normalizeSettings` 的 `prompts` 兜底(约 1850 行)补两行 `typeof rp.X === 'string' ? rp.X : ''`。**不从 `comfySpec` 迁**。

### 2. `src/autoTag/prompt.ts`

- 重写 `backendPromptSpec` 上方那段解释「imgrouter 复用 comfy」的注释(现在不复用了,理由换成上表第 2、3 条)。
- 抽出 `resolveNlMacro(template, nlOn)`:`{{nl}}` 存在则替换,不存在且开关开则追加到末尾,最后折叠连续空行。comfy 与 imgrouter 两条分支共用它,避免同样 8 行写两遍。
- `backendPromptSpec` 拆成三段:`imgrouter` → `imgRouterSpec || DEFAULT_IMGROUTER_SPEC`;`comfyui` → 原逻辑;NAI 系不变。
- `backendThinkingPrompt` 加 `imgrouter` 分支 → `imgRouterThinking || DEFAULT_IMGROUTER_THINKING`;webui 保持回落 comfy 那份。
- 补两个 import。

### 3. `src/pages/settings/index.vue`

- import 两个新常量。
- `TAG_PROMPT_METAS` 在 ComfyUI 那对之后插入两条:
  - `ImgRouter 规范`,带 `{{nl}}` 宏标签(宏说明改成「ImgRouter 面板开启『生成自然语言』时展开」——ImgRouter 的开关在渠道级,不在工作流预设里)。
  - `ImgRouter 思维链`。
- 更新 `TAG_PROMPT_METAS` 上方注释:现在是三对(NAI / ComfyUI / ImgRouter)。

### 4. `src/autoTag/prompt.test.ts`

- `prompts()` helper 补两个空串键。该 helper 的注释本来就写着「每加一个键,散落的字面量会同时 typecheck 失败」,这就是它存在的意义。不新增测试用例。

## 风险

1. **存量 ImgRouter 用户的出图结果会变**:此前 ImgRouter 吃的是 comfy 那份(含转义括号),现在改吃专属默认。这是本次选择「另写一份」的直接后果,也正是要修的缺陷(反斜杠会漏进提示词)。若曾自定义过 `comfySpec` 并用于 ImgRouter,那份内容仍在「ComfyUI 规范」里,可自行复制进新的 ImgRouter 槽位。
2. **两份文本会漂移**:tag 排序、词表、多人绑定这些通用规则现在有三份(comfy / nai / imgrouter)。已在两份的文件头注释里互相点名,改一处时提醒对照。
3. 不涉及公共 API、不涉及删除,`AutoTagPrompts` 只加键 ⇒ 存量 settings 读进来照旧,老版本 settings 无该键时回落空串 = 走新内置默认。

## 验证

- `pnpm typecheck`
- `pnpm test`(vitest,含 `prompt.test.ts` 与三份 settings 迁移测试)
