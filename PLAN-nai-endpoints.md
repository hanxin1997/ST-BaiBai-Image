# NAI 渠道:接口地址 + API Key 多站点切换

## 需求

NAI 渠道支持保存多套「接口地址 + API Key」(官方站 + 任意多个镜像站),在下拉里一键切换。
只切这两项,其余出图参数不动。

## 结论:改 3 个文件

| 文件 | 改动 |
| --- | --- |
| `src/state/settings.ts` | 加 `endpoints[]` / `activeEndpointId` 两个字段 + 清洗 + 存量迁移 |
| `src/pages/backend/panels/NaiPanel.vue` | 「配置」区顶部加一行站点选择器(4 个图标操作) |
| `src/backends/nai.test.ts` | 工厂函数补两个新字段(否则类型检查挂) |

`backends/nai.ts`、`floor/Card.vue`、`autoTag/*` **一行不改**,原因见下面的不变式。

面板是 `target: 'nai' | 'latent'` 参数化的(NaiPanel.vue:77),所以 latent 渠道同样
白拿这个能力,两边各存各的站点库(与现在 URL/Key 各存一份的口径一致)。

## 数据结构

`settings.ts` 新增,形制照搬 `ComfyWorkflowPreset`:

```ts
/** 一套「接口地址 + Key」。切站点只切这两项,出图参数留在渠道级。 */
export interface NaiEndpoint {
  id: string;      // ep_<ts>_<seq>,不与 wf_/art_/ch_ 相撞
  name: string;    // 显示名,如「官方」「某镜像」
  url: string;
  key: string;
}
```

`NaiSettings`(settings.ts:224)加两格:

```ts
/** 站点库。**恒非空**(照 workflows 口径:没地址就出不了图)。 */
endpoints: NaiEndpoint[];
/** 当前站点 id;悬空时由 normalizeNai 回落第一条。 */
activeEndpointId: string;
```

配套三个函数,命名与位置照现有惯例:`newNaiEndpoint()`(旁邻 `newNaiArtist`)、
`activeNaiEndpoint(conn)`(旁邻 `activeNaiArtist`)、`normalizeNaiEndpoint()`
(旁邻 `normalizeArtistPreset`)。

## 核心不变式(这是下游零改动的原因)

```
conn.url / conn.key 恒等于当前站点的 url / key
```

`url` / `key` **保留在 NaiSettings 上不动**,作为当前站点的活值镜像。
`backends/nai.ts` 的三处 fetch(user/subscription、generate-image、encode-vibe)
照旧读 `nai.url` / `nai.key`,`floor/Card.vue`、`autoTag/prompt.ts`、`hydrate.ts`
拿到的还是同一个 `NaiSettings` 形状 —— 全部无感。

为什么不把 `url`/`key` 挪进 endpoints、让下游改读 `activeNaiEndpoint()`:
那要动 nai.ts 三处 + 4 个调用方文件 + 6 个测试,只为省掉一个字段,不划算。

不变式只有 **3 个写入点**,全部在受控位置,没有第四处(已 grep 全项目确认
`settings.nai.url` / `.key` 只有面板在写):

1. `normalizeNai` —— 每次载入都按当前站点重算 `url`/`key`,脏数据自愈
2. 切站点 —— 一个 `switchEndpoint()` 函数,把 preset 的值拷进活值
3. 编辑输入框 —— computed 的 setter 同时写 preset 与活值(见下)

第 3 点是关键:输入框不再直接绑 `conn.url`,改绑一个读写 computed ——

```ts
const endpointUrl = computed({
  get: () => activeEndpoint.value.url,
  set: v => { activeEndpoint.value.url = v; conn.value.url = v; },  // 一次写两处
});
```

这样「改了地址没点保存就切走」不会丢字:编辑即时落进当前站点。
不用 `watch` 是因为面板未挂载时 watch 不跑,而出图是从楼层触发的。

## 存量迁移

老用户没有 `endpoints` 键 → 用现有 `url`/`key` 折成第一条并选中,
口径同 `foldLegacyWorkflow`:**用户特意设过的值绝不被默认值顶掉**。

第一条的名字按 url 定,不解析域名(省掉一堆异常分支):

| 现有 url | 名字 |
| --- | --- |
| `https://image.novelai.net` | 官方 |
| 空串(latent 默认) | 默认 |
| 其它(已在用镜像站) | 当前站点 |

升级后行为零变化:下拉里一条、地址与 Key 原样。新装用户走 `naiDefaults()`,
出生即带一条「官方」—— 只用一个站点的人根本不会察觉「库」这个概念。

## 界面

「配置」折叠区顶部加一行,形制与同文件的画师串行(NaiPanel.vue:804)一模一样:

```
┌ 配置 ──────────────────────────────────────────┐
│  站点   [ 官方            ▾ ]   ✎  ＋  ⧉  🗑   │  ← 新增这一行
│                                                │
│  接口地址                                      │
│  [ https://image.novelai.net                 ] │  ← 改绑当前站点
│  默认官方;第三方站填域名即可,自动补全 /ai 端点  │
│                                                │
│  API Key                                       │
│  [ ••••••••••••••••••••••••••  ] [ 👁 ]        │  ← 改绑当前站点
│  官方站在 NovelAI 设置页生成                    │
│                                                │
│  [使用此渠道出图]              [🔌 测试连接]    │
└────────────────────────────────────────────────┘
```

四个图标操作(复用 `.art-op` 那套 30×30 图标钮,文案退到 title/aria-label):

- **✎ 改名** —— 点了把下拉原地换成输入框,Enter/失焦确认、Esc 取消(照 `startRenameArtist`)
- **＋ 新增** —— 建一条空站点「站点 N」并切过去,地址与 Key 都空着等填
- **⧉ 复制** —— 连地址带 Key 拷一份,改个 Key 就是同一镜像站的另一个号
- **🗑 删除** —— 走 `ConfirmDialog`;只剩一条时禁用(恒非空是不变式,禁用比点了没反应诚实)

切站点后「测试连接」直接可用 —— 它吃的就是 `conn` 的活值。

## 关于「保存」按钮:不加

`settings.ts:2029` 有一个 `{ deep: true }` 的 watch → `persist()` → `saveSettingsDebounced`。
**改动本来就自动落盘**,再放个「保存」按钮反而害人:用户会以为不点就没存,
点了才存 —— 而实际上早存了,按钮只是安慰剂。切换/新增/改名同理,都是即时生效。

如果你更想要「草稿态 + 显式提交」那套(编辑不落盘,点保存才写进站点库),
说一声,那是另一套交互,我改方案 —— 但会多一层草稿状态,复杂度不止一个按钮。

## 风险

破坏性:无。只加键,不删不改签名,存量数据全走迁移。
已在用镜像站的用户:地址与 Key 原样折成「当前站点」,一次都不用重填。
Key 落盘位置不变(照旧随 settings 走 ST 的 extension_settings)——不新增泄露面。

## 验证

- `pnpm test` —— 现有 NAI 相关 6 个测试文件必须全绿(尤其 4 个 migration)
- `pnpm typecheck` —— 类型检查(新字段是否漏补)
- `pnpm build` —— 构建产物
- 手测:新增一条镜像站 → 填地址/Key → 测试连接 → 切回官方 → 再切回来,值仍在

