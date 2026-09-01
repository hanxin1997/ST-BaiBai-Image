<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useAttrs, watch } from 'vue';

/**
 * 自适应高度 textarea(默认一行,内容超出按内容长高,封顶后内部滚动)。
 *
 * 为什么做成组件:此前各页散装「textarea + v-autosize 指令 + 自配 max-height class」,
 * 口径不一还各有缺口。组件统一收口:
 * - 行数口径:props.rows 起始行、maxRows 封顶行,以 lineHeight 换算像素,
 *   不再让调用方自己写 max-height。
 * - v-model 按 Vue 原生 textarea 口径用 compositionstart/end 挡 IME 拼音串,
 *   这是指令版(v-autosize)没有的。
 * - ResizeObserver 监听自身宽度变化(窗口缩放/抽屉拖动)后重量,
 *   Book 那边窄窗口下手动拖宽后高度不回落就是漏了这个。
 * - focus()/insertAtCursor() 暴露给调用方(提示词弹窗的宏插入依赖光标操作)。
 *
 * 高度测量与指令版同思路:height 先归零再读 scrollHeight(归零是必须的,
 * 否则内容减少时 scrollHeight 不回落),写回时再夹在 [min,max] 之间。
 * 挂载/更新都等一帧再量,避免编辑回填时读到塌陷中的布局。
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    /** 起始行数(空内容时的高度) */
    rows?: number;
    /** 封顶行数;超出后出现滚动条。默认 12 */
    maxRows?: number;
    /** 等宽字体(工作流 JSON / tag 串用) */
    mono?: boolean;
    /** 占位符 */
    placeholder?: string;
    /** 关闭拼写检查(tag/JSON 场景默认关;纯中文描述可开) */
    spellcheck?: boolean;
  }>(),
  { rows: 1, maxRows: 12, mono: false, placeholder: '', spellcheck: false },
);

const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

// 透传 class/style(合并到根 textarea,保持 .bbi-input 等既有工具类可用)
const attrs = useAttrs();

const el = ref<HTMLTextAreaElement | null>(null);
/** 单行像素高:mounted 后测一次;行数→像素换算的基准 */
let lineHeightPx = 21;

const composing = ref(false);
function onInput(event: Event) {
  if (composing.value) return;
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value);
}
function onCompositionStart() {
  composing.value = true;
}
function onCompositionEnd(event: CompositionEvent) {
  composing.value = false;
  // 兼容部分浏览器不触发 input 的口径:结束时统一以最终值回写一次
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value);
}

function measure(): void {
  const node = el.value;
  if (!node) return;
  node.style.height = 'auto';
  // scrollHeight 只含内容+上下 padding,box-sizing:border-box 时须补边框才是总占用高度
  const content = node.scrollHeight;
  const style = window.getComputedStyle(node);
  const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  const min = lineHeightPx * props.rows;
  const max = lineHeightPx * props.maxRows;
  node.style.height = `${Math.max(min, Math.min(max, content + border))}px`;
  node.style.overflowY = content + border > max ? 'auto' : 'hidden';
}

let ro: ResizeObserver | null = null;

function setup() {
  const node = el.value;
  if (!node) return;
  const style = window.getComputedStyle(node);
  lineHeightPx = parseFloat(style.lineHeight) || 21;
  ro?.disconnect();
  ro = new ResizeObserver(() => measure());
  // 观察自身:宽度变化(拖动/缩放)时高度要跟着重排
  ro.observe(node);
  requestAnimationFrame(() => measure());
}

defineExpose({
  /** 聚焦 */
  focus() {
    el.value?.focus();
  },
  /**
   * 在光标处插入文本并选中;无焦点时追加到末尾。
   * 用于宏按钮:返回插入后的光标位置,调用方如需移动光标再自行处理。
   */
  insertAtCursor(text: string): void {
    const node = el.value;
    if (!node) {
      emit('update:modelValue', props.modelValue + text);
      return;
    }
    const start = node.selectionStart ?? props.modelValue.length;
    const end = node.selectionEnd ?? start;
    const next = props.modelValue.slice(0, start) + text + props.modelValue.slice(end);
    emit('update:modelValue', next);
    void nextTick(() => {
      node.focus();
      const pos = start + text.length;
      node.setSelectionRange(pos, pos);
    });
  },
});

onMounted(setup);
// rows/maxRows 变化时上下限变了,重新夹一次高度(模板编辑等场景会动态改)
watch(() => [props.rows, props.maxRows], () => requestAnimationFrame(() => measure()));
// 程序化改值(弹窗回填草稿/恢复默认)不触发 input 事件,这里补量(输入路径重复量一次无害)
watch(
  () => props.modelValue,
  () => requestAnimationFrame(() => measure()),
);

onBeforeUnmount(() => ro?.disconnect());

defineOptions({ inheritAttrs: false });
</script>

<template>
  <textarea
    ref="el"
    class="bbi-textarea"
    :class="{ 'is-mono': mono }"
    v-bind="attrs"
    :value="modelValue"
    :placeholder="placeholder"
    :spellcheck="spellcheck"
    :rows="rows"
    @input="onInput"
    @compositionstart="onCompositionStart"
    @compositionend="onCompositionEnd"
  ></textarea>
</template>

<style scoped>
.bbi-textarea {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface);
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  font-size: 13px;
  line-height: 1.6;
  box-sizing: border-box;
  display: block;
  resize: none;
  overflow-y: hidden;
}
.bbi-textarea.is-mono {
  font-family: var(--bbi-font-mono);
  font-variant-ligatures: none;
}
.bbi-textarea:focus {
  outline: none;
  border-color: var(--bbi-accent);
}
.bbi-textarea::placeholder {
  color: var(--bbi-ink-muted);
}
.bbi-textarea:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>
