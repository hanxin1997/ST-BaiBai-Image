<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import type { Orientation } from '@/backends/size';
import BbiTextarea from '@/components/BbiTextarea.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { containsTagMarkup, type ImageTagContent } from '@/st/imageTagRegex';

/**
 * 手动编辑生图提示词的弹窗(楼层卡片 ⋯ 菜单里的铅笔钮)。
 *
 * 【为什么编辑结构化字段而不是一个大文本框】
 * 卡片上那个 promptText(Card.vue)是拼给人看的展示串,带「角色: 小雪」「Negative: 」
 * 前缀,**不可逆解析**。这里按 ImageTagContent 的五个字段分别编辑,保存时由
 * serializeImageTag 统一序列化 —— 没给编辑的字段也原样带回,不会静默吃掉 characters。
 *
 * 【本组件是命令式挂载的(floor/promptEditor.ts),活得比卡片长】
 * 任一兄弟槽位出图都会重水合、销毁卡片,而弹窗还开着。故楼层坐标一律由调用方快照后
 * 传参,组件内绝不去读卡片的 props —— 与 Lightbox 同一条纪律。
 */

const props = defineProps<{
  /** 打开时的原始内容(解析结果);草稿以此为基准比对「有没有真的改」。 */
  content: ImageTagContent;
  /** 当前提示词下已有几张图(>1 时提示改提示词会收成一张)。 */
  historyCount: number;
  /** 后端是否已配置好(未配置时「应用并重新生成」不可点)。 */
  configured: boolean;
  /** 忙碌中(写回正在进行):禁用底部按钮,避免连点写两次。 */
  busy?: boolean;
  /**
   * 调用方要求关闭:置 true 后本组件播离场动画。
   * **不能反过来用 ref 拿组件实例**——本组件是 render(h(...)) 命令式挂载的,
   * 没有父组件实例,`ref` 的 owner 为 null:挂载时 Vue 静默跳过(有 parentComponent 护栏),
   * 卸载时那道护栏没有,直接读 owner.refs 抛 "Cannot read properties of null"。
   * 状态一律走 props/emit,别把 ref 当逃生口。
   */
  closing?: boolean;
}>();

const emit = defineEmits<{
  /** 应用;regenerate=true 表示写回后直接开跑出图。 */
  (e: 'apply', value: ImageTagContent, regenerate: boolean): void;
  /** 草稿是否已改动(调用方据此决定关窗前要不要问「放弃修改?」)。 */
  (e: 'dirty', value: boolean): void;
  (e: 'close'): void;
}>();

/**
 * 显隐态。**初值必须是 false**:Vue 的 <Transition> 默认不给首次渲染播动画(没有 appear),
 * 挂载时就 true 的话弹窗会硬邦邦地直接出现。挂载后翻成 true 才有入场动画 ——
 * 与设置页那些「open 从 false 翻上来」的弹窗表现一致。
 */
const open = ref(false);

const tag = ref(props.content.tag);
const nl = ref(props.content.nl);
const negative = ref(props.content.negative);
const size = ref<Orientation>(props.content.size);
const characters = ref<ImageCharacterPrompt[]>(
  props.content.characters.map(character => ({ ...character })),
);

/** 换行折成空格:与 parseImageTagContent 的 oneLine 同口径(提示词里换行没有意义)。 */
function oneLine(text: string): string {
  return text.trim().replace(/[\r\n]+/g, ' ');
}

/** 草稿归一后的结果 —— 保存与「有没有改」都以它为准,两处不能各算一次。 */
const draft = computed<ImageTagContent>(() => ({
  tag: oneLine(tag.value),
  nl: oneLine(nl.value),
  negative: oneLine(negative.value),
  characters: characters.value
    .map(character => ({
      name: oneLine(character.name),
      tag: oneLine(character.tag),
      nl: oneLine(character.nl),
    }))
    // 与 parseImageTagContent 同口径:name/tag 缺一条即丢弃(空行不落进正文)
    .filter(character => character.name && character.tag),
  size: size.value,
}));

function sameCharacters(a: ImageCharacterPrompt[], b: ImageCharacterPrompt[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (item, index) =>
      item.name === b[index].name && item.tag === b[index].tag && item.nl === b[index].nl,
  );
}

/**
 * 草稿与原始内容是否一致。**按字段比对,不比对序列化结果**:
 * 解析是容忍式的(裸文本 / 显式 <tag> / 缺子标签都收),序列化是规范式的,
 * 一个手写的非规范 tag 打开再原样保存,序列化出来的原文就变了 → promptHash 变了 →
 * 明明什么都没改,老图却全变成「旧提示词」。
 */
const dirty = computed(() => {
  const next = draft.value;
  return (
    next.tag !== props.content.tag ||
    next.nl !== props.content.nl ||
    next.negative !== props.content.negative ||
    next.size !== props.content.size ||
    !sameCharacters(next.characters, props.content.characters)
  );
});

/** 校验:tag 必填 + 全字段禁含子标签字面量(口径与 AI 侧同一份)。 */
const error = computed(() => {
  const next = draft.value;
  if (!next.tag) return '画面 tag 不能为空';
  const fields: Array<[string, string]> = [
    ['画面 tag', next.tag],
    ['自然语言', next.nl],
    ['负面提示词', next.negative],
  ];
  for (const character of next.characters) {
    fields.push([`角色「${character.name}」`, `${character.name} ${character.tag} ${character.nl}`]);
  }
  for (const [label, value] of fields) {
    if (value && containsTagMarkup(value)) {
      return `${label}不能包含 <bbi_image> / <tag> / <nl> / <negative> / <characters> / <size> 标签`;
    }
  }
  return '';
});

const canApply = computed(() => !error.value && !props.busy);

function addCharacter(): void {
  characters.value.push({ name: '', tag: '', nl: '' });
}

function removeCharacter(index: number): void {
  characters.value.splice(index, 1);
}

function apply(regenerate: boolean): void {
  if (!canApply.value) return;
  emit('apply', draft.value, regenerate);
}

/** 关闭前的丢弃确认交给调用方(它有 confirmDialog,且要按 dirty 决定问不问)。 */
function requestClose(): void {
  if (props.busy) return;
  emit('close');
}

// 草稿改动态推给调用方(它没有组件实例可读,见 closing prop 的注释)
watch(dirty, value => emit('dirty', value), { immediate: true });

// 调用方要求关闭 → 播离场动画;真正的卸载由调用方在动画时长后做
watch(
  () => props.closing,
  value => {
    if (value) open.value = false;
  },
);

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  // 捕获阶段:抢在 ST 的全局快捷键之前拿到 Esc(否则会连带关掉别的东西)
  event.stopPropagation();
  requestClose();
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown, true);
  // 翻开 open 触发入场动画(见 open 的声明处);同一 tick 内改不算变化,故等一帧
  requestAnimationFrame(() => {
    open.value = true;
  });
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true);
});
</script>

<template>
  <ModalMask :open="open" top-layer @close="requestClose">
    <div
      class="bbi-modal bbi-modal-wide"
      role="dialog"
      aria-modal="true"
      aria-label="编辑提示词"
    >
      <header class="bbi-modal-head">
        <span class="bbi-modal-title">编辑提示词</span>
        <button class="bbi-icon-mini" type="button" title="关闭" @click="requestClose">
          <Icon name="close" />
        </button>
      </header>

      <div class="bbi-modal-field">
        <span class="bbi-modal-label">画面 tag(danbooru 短 tag,逗号分隔)</span>
        <BbiTextarea
          v-model="tag"
          class="bbi-prompt-area"
          :rows="4"
          :max-rows="14"
          mono
          placeholder="1girl, long black hair, school uniform, classroom"
        />
      </div>

      <div class="bbi-modal-field">
        <span class="bbi-modal-label">自然语言(可留空;部分后端/模型用得到)</span>
        <BbiTextarea
          v-model="nl"
          class="bbi-prompt-area"
          :rows="2"
          :max-rows="10"
          placeholder="A girl standing by the classroom window at sunset."
        />
      </div>

      <div class="bbi-modal-field">
        <span class="bbi-modal-label">本画面负面提示词(可留空;与渠道级负面词叠加)</span>
        <BbiTextarea
          v-model="negative"
          class="bbi-prompt-area"
          :rows="2"
          :max-rows="10"
          mono
          placeholder="extra people, duplicate"
        />
      </div>

      <div class="bbi-modal-field">
        <span class="bbi-modal-label">画幅方向(具体像素在「渠道」页配置)</span>
        <div class="bbi-segmented" role="tablist" aria-label="画幅方向">
          <button
            class="bbi-seg"
            :class="{ 'is-on': size === 'portrait' }"
            type="button"
            role="tab"
            :aria-selected="size === 'portrait'"
            @click="size = 'portrait'"
          >
            竖屏
          </button>
          <button
            class="bbi-seg"
            :class="{ 'is-on': size === 'landscape' }"
            type="button"
            role="tab"
            :aria-selected="size === 'landscape'"
            @click="size = 'landscape'"
          >
            横屏
          </button>
        </div>
      </div>

      <div class="bbi-modal-field">
        <span class="bbi-modal-label">
          角色提示词(多角色;仅 NAI 后端发送)
        </span>
        <div v-for="(character, index) in characters" :key="index" class="bbi-char-row">
          <input
            v-model="character.name"
            class="bbi-input bbi-char-name"
            type="text"
            placeholder="角色名"
          />
          <input
            v-model="character.tag"
            class="bbi-input bbi-char-tag"
            type="text"
            placeholder="tag(如 girl, black hair)"
          />
          <input
            v-model="character.nl"
            class="bbi-input bbi-char-nl"
            type="text"
            placeholder="自然语言(可空)"
          />
          <button
            class="bbi-icon-mini"
            type="button"
            title="删除这个角色"
            @click="removeCharacter(index)"
          >
            <Icon name="trash" />
          </button>
        </div>
        <button class="bbi-btn bbi-btn-sm bbi-char-add" type="button" @click="addCharacter">
          <Icon name="plus" /> 添加角色
        </button>
        <span class="bbi-field-hint">角色名与 tag 都填了才会生效,留空的行保存时自动丢弃。</span>
      </div>

      <!-- 改提示词会换 promptHash 桶,而 stale 态只显示最新一张、翻页器不出现。
           这是既有存储设计,但手动改提示词会让它从边角情况变成日常,故明确告知。 -->
      <p v-if="historyCount > 1" class="bbi-editor-note">
        当前提示词下已有 {{ historyCount }} 张图。修改后只显示最新一张(图片没有被删除,
        把提示词改回原样即可全部找回)。
      </p>

      <p v-if="error" class="bbi-editor-error">{{ error }}</p>

      <footer class="bbi-modal-foot">
        <span class="bbi-modal-foot-spacer"></span>
        <button class="bbi-btn" type="button" :disabled="busy" @click="requestClose">取消</button>
        <button class="bbi-btn" type="button" :disabled="!canApply" @click="apply(false)">
          应用
        </button>
        <button
          class="bbi-btn bbi-btn-primary"
          type="button"
          :disabled="!canApply || !configured"
          :title="configured ? '保存提示词并立即出图' : '请先在柏宝绘「渠道」页完成配置'"
          @click="apply(true)"
        >
          <Icon name="palette" /> 应用并重新生成
        </button>
      </footer>
    </div>
  </ModalMask>
</template>

<style scoped>
/* —— 以下四条在 base.css 里不是全局的,scoped 过不了组件边界,各处各抄一份
      (同 ConfirmDialog.vue 的做法) —— */
.bbi-modal-wide {
  max-width: 680px;
}

.bbi-icon-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface);
  color: var(--bbi-ink-soft);
  cursor: pointer;
  font-size: 14px;
}
.bbi-icon-mini:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}

.bbi-modal-foot-spacer {
  flex: 1 1 auto;
}

.bbi-prompt-area {
  line-height: 1.6;
  font-size: 12.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
}

/* —— 角色行:名字窄、tag 与自然语言各占一半,删除钮跟在末尾 —— */
.bbi-char-row {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-top: 6px;
}
.bbi-char-name {
  flex: 0 0 96px;
  min-width: 0;
}
.bbi-char-tag,
.bbi-char-nl {
  flex: 1 1 0;
  min-width: 0;
}
.bbi-char-add {
  align-self: flex-start;
  margin-top: 8px;
}

.bbi-editor-note {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  font-size: 12px;
  line-height: 1.7;
  color: var(--bbi-ink-soft);
}

.bbi-editor-error {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--bbi-danger);
}

/* 窄屏:角色行改竖排,否则三个输入框挤成条 */
@media (max-width: 560px) {
  .bbi-char-row {
    flex-wrap: wrap;
  }
  .bbi-char-name {
    flex: 1 1 100%;
  }
  .bbi-char-tag,
  .bbi-char-nl {
    flex: 1 1 100%;
  }
}
</style>
