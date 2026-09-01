# 计划:img-router 接入(独立链条)+ 获取模型 + img-router 侧 4 个修复

## 决策(已确认)

| 项 | 选择 |
|---|---|
| 生图接口 | `POST /v1/images/generations`,`response_format: b64_json` |
| img-router | **一起改**(CORS + 模型可见性) |
| Krea 显示名 | 缩写,不用中文:`PM-Turbo` / `Muse-Turbo` / `Custom` |
| 自动 tag 规范 | 复用 `prompts.comfySpec` / `comfyThinking` + 渠道级自然语言开关,**不新增提示词字段** |
| 链条形态 | 全新独立链条(新 BackendId / settings 块 / 后端模块 / 面板 / 分发分支 / 历史标签),配置骨架复制现有 `backendDefaults()` |

---

# A. img-router-main 侧修复

## A1「看不到三个模型」的真因(已实测)

用 `config.ts` 真实值复算 `handleModelsRequest`,输出 23 条,**三个模型都在**:

```
pornmaster  [HuggingFace-Krea]
muse        [HuggingFace-Krea]
custom      [HuggingFace-Krea]
```

所以不是漏发,而是被下面三件事挡住:

**A1-a｜管理界面下拉在 auto 模式下什么都不列。** `ui/app.js:940-945`:

```js
if (provider === 'auto') {
  modelSelect.innerHTML = '<option value="">自动选择（根据 Key 决定）</option>';
  return;                       // ← 直接返回,一个模型都不渲染
}
```

你的 `data/ui-config.json` 里 `activeProvider: "auto"` —— 界面上自然一个模型都看不见。
**改**:auto 模式保留「自动选择」为首项,后面按渠道分组(`<optgroup>`)列出全部模型。

**A1-b｜`/v1/models` 无 CORS 头,浏览器侧客户端读不到。** 见 A2。

**A1-c｜显示名是中文长串,且多数客户端只认 `id`。** 改为缩写(A3)。

## A2 CORS:19 个响应里 13 个缺头(实测)

| 行 | 状态 | ACAO |
|---|---|---|
| 133 / 144 / 156 / 174 / 196 | 401 | ❌ |
| 1886 / 1987 / 2056 / 2098 | 500 | ❌ |
| 2170 (`/v1/models`) | 200 | ❌ |
| 2187 (`/health`) | 200 | ❌ |
| 2205 / 2282 | 405 | ❌ |
| 2215 | 404 | ❌ |
| 1947 / 1973 / 2007 / 2085 / 2265 | — | ✅ |

后果:令牌错(401)、生图失败(500)、模型列表(200)全被浏览器拦掉 —— 插件只能报「请求失败」,拿不到 `All providers failed: ...` 这类真实原因。

**改**:在 `main.ts` 加一个 `jsonResponse(body, status?)` helper 统一带上 CORS 头,把 19 处 `new Response(JSON.stringify(...))` 全部走它。**不是**在 13 处各粘一遍头 —— 那样下次加路由还会漏。

## A3 Krea 显示名改缩写

| id | display |
|---|---|
| `pornmaster` | `PM-Turbo` |
| `muse` | `Muse-Turbo` |
| `custom` | `Custom` |

checkpoint 映射不动(`pornmasterKrea2_v2TurboInt8.safetensors` / `museByStableYogi_v25EXTENDEDTURBO.safetensors` / `__custom_huggingface_base_model__`)。

两处要同步改(`config.ts` 的 `kreaModelDisplayMap`、`ui/app.js` 的 `kreaDisplayNames`)。这份映射天然重复 —— `ui/app.js` 是静态浏览器文件,没法 import Deno 侧 config;`/api/providers` 接口存在但 UI 从不调用它。本次不动这个结构,只保证两处一致,并在两处各加一行注释互指。

## A4 顺带修:`/v1/models` 有重复 id(实测)

```
z-image-turbo         x2   (Gitee / HuggingFace)
Qwen-Image-Edit-2511  x2   (Gitee / HuggingFace)
```

按 id 建下拉的客户端只会留一条,另一条渠道信息丢失。
**改**:按 id 合并,`owned_by` 合成 `"Gitee,HuggingFace"`。23 条 → 21 条,不再有重复 id。

---

# B. 插件侧:全新 imgrouter 链条

## B1 协议口径

```
POST {base}/v1/images/generations
Authorization: Bearer <accessToken>
{ "prompt": "<质量词 + tag + nl>", "model": "<可选>", "size": "832x1216",
  "response_format": "b64_json", "n": 1 }
```

- `size`:面板存 `832×1216`(全角 ×),`parseSize` 解析后发 ASCII `832x1216`;解析不出则不发,由 img-router 用自身默认值。
- `model`:留空不发,由 img-router 按渠道回落默认模型。
- `response_format` 固定 `b64_json`:base64 由 img-router 服务端转好,浏览器不用去抓图床 URL(避开图床自身的 CORS)。响应只给 `url` 时(img-router 转码失败的兜底)原样返回,交落盘层 fetch。
- **不发** `negative_prompt` / `seed`:img-router 没有这两个参数。

响应 `{ created, data: [{ b64_json }] }` → 取 `data[0]`,base64 魔数判 png/jpeg/webp → 拼 dataURL,返回现有 `ComfyImageResult` 形状,落盘层零改动。

## B2 仍需如实告知的两点

1. **选错模型会被静默回落**。每个渠道各自 `supportedModels.includes(model)` 校验,不在自己名单里就换成该渠道默认模型,不报错。而 `/v1/models` 是全渠道并集 —— 选了不属于你 accessToken 勾选渠道的模型,出的图不是你选的那个。面板要明示,并把 `owned_by` 显示出来。
2. **accessToken 无法在不真实生图的前提下验证**(`/v1/models` 不校验 token)。「测试连接」只能证明地址可达。

## B3 改动清单(11 个文件:新增 2 / 修改 5 插件 + 4 img-router)

### 新增 `src/backends/imgRouter.ts`
`ImgRouterError`、`imgRouterEndpoint()`(仿 `naiEndpoint`,补 `/v1`)、`imgRouterFullPrompt()`(质量词 + tag + nl)、`fetchImgRouterModels()`(直连优先 → 失败回落 ST 服务端代理,返回 `{ models, mode }`,`models` 带 `id`/`ownedBy`/`display`)、`generateImgRouterImage()` → `Promise<ComfyImageResult>`。

ST 代理回落保留:远端/未打补丁的 img-router 仍能用(那时只拿得到 `id`)。

### 新增 `src/pages/backend/panels/ImgRouterPanel.vue`
服务地址 / 访问令牌(password + 眼睛,仿 NaiPanel)/ 模型(`BbiCombo`,候选为**裸 id**,下方提示行显示当前 id 的 `display · ownedBy`)/「获取模型」/ 正面质量词 / 竖屏·横屏尺寸 / 生成自然语言开关 /「使用此渠道出图」。写明 B2 两条。

> 模型框用 id 而非显示名:`BbiCombo` 的值就是输入框文本,若显示 `PM-Turbo` 就会把它当模型名发出去。故候选用 id,友好名放提示行。

### `src/state/settings.ts`
- `BackendId` 加 `'imgrouter'`;`BACKENDS` 加 `{ value: 'imgrouter', label: 'ImgRouter' }`
- 新 `ImgRouterSettings extends BackendConn`:`key` / `model` / `naturalLanguage`
- `imgRouterDefaults()` = `{ ...backendDefaults('http://127.0.0.1:10001'), key:'', model:'', naturalLanguage:true }`
- `ImageSettings.imgrouter`、`defaults()`、`normalizeImgRouter()`、`merge()`、`applyInto()` 同步补齐
- 顺带**去重**:导出 `SELECTABLE_BACKENDS`(非 webui 的可选后端),替换 `defaultBackend` 迁移守卫的布尔链,并让 `pages/backend/index.vue`、`pages/settings/index.vue` 两处重复的 `filter(b => b.value !== 'webui')` 共用它 —— 否则每加一个后端要改三处

### `src/floor/Card.vue`
`imgRouterActive` 计算属性;`configured` 加 imgrouter 门槛(url + key);抽出 `runGeneration()` 承接三路分发(`generate()` 现已 105 行,再塞一路更难读;抽出后本次新增不再加深它);种子:img-router 无 seed,历史记 0。

### `src/state/history.ts`
`ImageRecord.backend` 与 `beginImage` 入参联合类型加 `'imgrouter'`(2 处)。

### `src/pages/history/index.vue`
第 74 行二元三目换成 `Record<ImageRecord['backend'], string>` 标签表,加 `imgrouter: 'ImgRouter'`。

### `src/autoTag/prompt.ts`
`backendPromptSpec()` 的 comfyui 分支同时接受 `'imgrouter'`(共用 `comfySpec` + `DEFAULT_COMFY_NL_SPEC`);`nlOn` 并入 `settings.imgrouter.naturalLanguage`。`backendThinkingPrompt()` 非 nai 已回落 `comfyThinking`,无需改。`negativeOn` 仅在 comfy 预设存在时为真,imgrouter 天然 false,与「无负面参数」一致,无需改。

### `src/pages/backend/index.vue`
`PANELS` 注册 `ImgRouterPanel`;`VISIBLE_BACKENDS` 改用 `SELECTABLE_BACKENDS`。

## B4 不改的部分
`floor/storage.ts`、`st/images.ts`、`backends/size.ts`、`autoTag/runner.ts`:新后端复用现有 `ComfyImageResult` 契约,这些层看不见新渠道。

---

## 风险与验证

- **img-router 改完要重新部署才生效**(Docker 需重新 build)。`jsonResponse` 是纯响应包装,不动业务逻辑;`/v1/models` 去重会让返回条数 23 → 21。
- 插件本地 **无 `node_modules`**,`vue-tsc` / `vitest` 跑不起来。需先 `pnpm install`(照 `pnpm-lock.yaml`,不引入新依赖)才能跑 `npx vue-tsc --noEmit` + `npx vitest run`。
- img-router 侧本地 **无 deno**,只能靠 `deno check` 之外的手段核对;我会用 node 复算 `/v1/models` 输出(已用过一次)确认去重与显示名结果,但**无法真实起服务验证**。这点如实说明。
