# 图库实现方案

## 现状

- 图片文件：`user/files/bbi_*.png`（平铺，ST 文件 API）
- 元数据：每条消息 `extra.bbiImage[swipeId][promptHash][]`
- 占位页：`src/pages/gallery/index.vue`（46 行）
- 可复用组件：`Lightbox.vue`（放大）、`download.ts`（另存）、`storage.ts`（读取）、`deleteImageFile`（删除）

## 核心决策

### 不依赖服务端插件

注释说「依赖柏宝库服务端插件的列举能力」是**误判**——元数据已经在 `ctx.chat` 消息里，遍历即可。

### 数据源

```typescript
function collectImages(ctx: STContext): GalleryImage[] {
  const images: GalleryImage[] = [];
  ctx.chat.forEach((msg, mesid) => {
    const store = readStore(msg);
    if (!store) return;
    const swipeId = msg.swipe_id ?? 0;
    Object.values(store[swipeId] ?? {}).forEach(entries => {
      entries.forEach(entry => {
        images.push({
          path: entry.path,
          prompt: entry.prompt,
          seed: entry.seed,
          createdAt: entry.createdAt,
          generationId: entry.generationId,
          mesid,
          swipeId,
          characterName: msg.name,
        });
      });
    });
  });
  return images;
}
```

### 界面布局

```
┌─────────────────────────────────────────────────────────┐
│ 图库                     [角色▾] [时间▾] [全选] [删除(5)] │
├─────────────────────────────────────────────────────────┤
│ ┌───┐ ┌───┐ ┌───┐ ┌───┐                                │
│ │☑ │ │☐ │ │☐ │ │☐ │  ← 响应式网格，悬浮显示选择框    │
│ │img│ │img│ │img│ │img│                                │
│ └───┘ └───┘ └───┘ └───┘                                │
│ ┌───┐ ┌───┐                                            │
│ │☐ │ │☐ │                                              │
│ │img│ │img│                                            │
│ └───┘ └───┘                                            │
│                                                         │
│ 共 42 张图片                                             │
└─────────────────────────────────────────────────────────┘
```

点击卡片 → 复用 `Lightbox.vue` 放大查看。

### 功能完整版

**筛选与排序**：
- 按角色筛选（下拉列表，含「全部角色」）
- 按时间排序（新→旧 / 旧→新）
- 搜索提示词（输入框，实时过滤）

**批量操作**：
- 全选 / 取消全选
- 单张勾选（checkbox）
- 批量删除（确认弹窗）
  - 删除文件（`deleteImageFile`）
  - 删除元数据（从 `extra.bbiImage` 移除）
  - 刷新列表

**单张操作**：
- 点击放大（Lightbox）
- 悬浮显示：角色名 + 楼层 + 时间
- Lightbox 内支持删除（单张）

### 文件改动

1. `src/pages/gallery/index.vue`：完整图库实现（~450 行）
2. `src/pages/gallery/collect.ts`：图片收集 + 筛选逻辑（~120 行）

## 实现细节

### 数据结构

```typescript
interface GalleryImage {
  path: string;           // /user/files/bbi_...
  prompt: string;         // 完整 tag 原文
  seed: number | null;
  createdAt: number;
  generationId: string;
  mesid: number;          // 消息索引
  swipeId: number;
  characterName: string;  // msg.name
}

interface GalleryState {
  images: GalleryImage[];
  filterCharacter: string | null;  // null = 全部
  sortOrder: 'desc' | 'asc';       // 时间排序
  searchQuery: string;             // 提示词搜索
  selected: Set<string>;           // generationId 集合
}
```

### 筛选逻辑

```typescript
const filtered = computed(() => {
  let result = images.value;
  
  // 角色筛选
  if (filterCharacter.value) {
    result = result.filter(img => img.characterName === filterCharacter.value);
  }
  
  // 搜索提示词
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase();
    result = result.filter(img => img.prompt.toLowerCase().includes(q));
  }
  
  // 排序
  result = [...result].sort((a, b) => 
    sortOrder.value === 'desc' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt
  );
  
  return result;
});
```

### 批量删除流程

1. 用户勾选 N 张图
2. 点「删除(N)」按钮
3. 确认弹窗（复用 `ConfirmDialog`）
4. 异步删除：
   ```typescript
   for (const img of selectedImages) {
     await deleteImageFile(img.path);           // 删文件
     await removeFromExtra(img.mesid, img);     // 删元数据
   }
   ```
5. 刷新列表，清空选择

### 缩略图策略

**不生成缩略图**，直接显示原图 + CSS 缩放：
- 图片已压缩为 JPG（`settings.compressToJpeg`）
- 缩略图显示约 180px，预加载成本可接受
- 避免额外存储与管理复杂度

### 样式

```css
.gal-toolbar {
  display: flex;
  gap: 10px;
  align-items: center;
}

.gal-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
  margin-top: 16px;
}

.gal-card {
  position: relative;
  aspect-ratio: 1;
  background: var(--bbi-surface-2);
  border-radius: var(--bbi-radius);
  overflow: hidden;
  cursor: pointer;
}

.gal-card img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.gal-card-checkbox {
  position: absolute;
  top: 8px;
  left: 8px;
  width: 20px;
  height: 20px;
  opacity: 0;
  transition: opacity 0.15s;
}

.gal-card:hover .gal-card-checkbox,
.gal-card-checkbox:checked {
  opacity: 1;
}

.gal-card-info {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 8px;
  background: linear-gradient(transparent, rgba(0,0,0,0.7));
  color: white;
  font-size: 12px;
  opacity: 0;
  transition: opacity 0.15s;
}

.gal-card:hover .gal-card-info {
  opacity: 1;
}
```

### 性能优化

- 图片懒加载：`<img loading="lazy">`
- CSS 提示：`content-visibility: auto`（大列表优化）
- 搜索防抖：300ms
- 删除操作：Progress 提示（`删除中... 3/10`）

## 验证

1. 创建 3 个聊天，每个生成 10 张图
2. 打开图库，确认 30 张全部显示
3. 筛选「角色 A」，确认只显示该角色的图
4. 搜索「girl」，确认过滤生效
5. 勾选 5 张，批量删除，确认文件 + 元数据都删除
6. 切换聊天，确认图库刷新
7. 空聊天显示空状态
8. 点击缩略图，Lightbox 正常打开
9. 全选 → 取消全选

## 风险与缓解

**大聊天性能**：
- 1000 条消息 × 5 张图 = 5000 张
- 缓解：懒加载 + `content-visibility` + 虚拟滚动（未来）
- 当前方案在 1000 张内流畅

**批量删除失败**：
- 某张删除失败不中断流程
- 最后统一提示「成功 8 张，失败 2 张」

**跨聊天查看**：
- 当前只显示当前聊天的图 → 符合「删聊天即删图」
- 未来可选「全部聊天」模式（需遍历 `chatMetadata` 全局）

## 时间估算

- 数据收集 + 筛选（`collect.ts`）：60 分钟
- 界面实现（布局 + 网格 + 工具栏）：90 分钟
- 批量删除逻辑：60 分钟
- 样式调整 + 响应式：45 分钟
- 空状态 + 错误处理：30 分钟
- 测试 + 修 bug：45 分钟

**总计：~5.5 小时**
