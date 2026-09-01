import cardCss from '@/floor/card.css?raw';
import themeCss from '@/styles/theme.css?raw';

/**
 * 卡片样式表:构造一次,经 adoptedStyleSheets 共享给每个卡片的 shadow root。
 * N 张卡片共用同一个 CSSStyleSheet 对象——零重复、零解析开销。
 *
 * 为什么要带上 theme.css:令牌定义在 `.bbi-root[data-theme=…]` 选择器下,
 * 而卡片的 shadow root 里没有 .bbi-root 祖先(shadow 边界挡住了选择器匹配,
 * 尽管自定义属性本身可继承)。故把 theme.css 的选择器改写到 :host 上,
 * 令牌就落在卡片自己的 shadow 根节点上。
 *
 * 改写规则:`.bbi-root[data-theme='x']` → `:host([data-theme='x'])`。
 * data-theme 由 hydrate.ts 写在 host 元素上,故用属性选择器形式。
 * 顺带把 `.bbi-root[data-theme='pastel'] .bbi-checkbox` 这类后代规则一并转换
 * (卡片里没有复选框,留着无害;不特殊处理反而更省事)。
 */

let sheet: CSSStyleSheet | null = null;
let fallbackCss: string | null = null;

function buildCss(): string {
  const scopedTheme = themeCss
    // 带 data-theme 的主题块:.bbi-root[data-theme='night'] → :host([data-theme='night'])
    .replace(/\.bbi-root\[data-theme=('|")([a-z]+)\1\]/g, ':host([data-theme=$1$2$1])')
    // 裸 .bbi-root(字体/圆角/间距等公共令牌块)→ :host
    .replace(/\.bbi-root(?![\w[-])/g, ':host');
  return `${scopedTheme}\n${cardCss}`;
}

/**
 * 取共享样式表。支持 adoptedStyleSheets 的环境返回 CSSStyleSheet,
 * 否则返回 null,由调用方退回克隆 <style>(见 cardStyleTextFallback)。
 */
export function cardStyleSheet(): CSSStyleSheet | null {
  if (sheet) return sheet;
  if (typeof CSSStyleSheet === 'undefined' || !('replaceSync' in CSSStyleSheet.prototype)) return null;
  try {
    const created = new CSSStyleSheet();
    created.replaceSync(buildCss());
    sheet = created;
    return sheet;
  } catch {
    return null;
  }
}

/** 老浏览器兜底:样式文本,由调用方塞进 shadow root 的 <style>。 */
export function cardStyleTextFallback(): string {
  fallbackCss ??= buildCss();
  return fallbackCss;
}
