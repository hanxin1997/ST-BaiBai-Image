/**
 * 提示词分段格式 —— 单一真源。
 *
 * 两处在用,格式必须一字不差:
 * - 请求历史页的「复制整条」(pages/history/index.vue):给人看的排查文本;
 * - latent 渠道的提示词打包(backends/nai.ts):真发给上游的正向提示词。
 *
 * 后者的需求原文就是「和请求历史一样的格式」。若两边各写一份,历史页改个标签
 * 就会让 latent 悄悄发出另一种格式的串 —— 而这种漂移只在出图效果上体现,查都没法查。
 *
 * 段间**单换行**(不是空行),与历史页既有 copyAll 一致。
 */

/** 一段:行首标签 + 正文。 */
export interface PromptSection {
  label: string;
  text: string;
}

/** 固定段标签。角色段是动态的,见 characterSectionLabel。 */
export const SECTION_LABELS = {
  prompt: '正向提示词',
  nl: '自然语言',
  negative: '负面',
} as const;

/** 角色段标签:`角色: 小雪`。 */
export function characterSectionLabel(name: string): string {
  return `角色: ${name}`;
}

/** 角色段正文:tag 与 nl 之间空一行(段内空行,与段间单换行区分开)。 */
export function characterSectionText(character: { tag: string; nl: string }): string {
  return [character.tag, character.nl].filter(Boolean).join('\n\n');
}

export interface PromptSectionInput {
  prompt: string;
  nl?: string;
  characters?: readonly { name: string; tag: string; nl: string }[];
  negative?: string;
}

/**
 * 摊成按顺序的分段:正向 → 自然语言 → 各角色 → 负面。
 *
 * 收录口径与历史页原有的 segments() 完全一致(正向段与角色段无条件收录,
 * nl/负面有值才收):历史页照这个顺序渲染只读列表,改口径会动到它的展示。
 * latent 打包侧不想要空段,交由 joinSections 过滤 —— 两边需求不同但格式同源。
 */
export function buildPromptSections(input: PromptSectionInput): PromptSection[] {
  const out: PromptSection[] = [{ label: SECTION_LABELS.prompt, text: input.prompt }];
  if (input.nl) out.push({ label: SECTION_LABELS.nl, text: input.nl });
  for (const character of input.characters ?? []) {
    out.push({
      label: characterSectionLabel(character.name),
      text: characterSectionText(character),
    });
  }
  if (input.negative) out.push({ label: SECTION_LABELS.negative, text: input.negative });
  return out;
}

/** 拼成一整串。空段直接丢掉 —— 发给上游的串里留个空标签只会占 token 又误导模型。 */
export function joinSections(sections: readonly PromptSection[]): string {
  return sections
    .filter(section => section.text.trim())
    .map(section => `--- ${section.label} ---\n${section.text.trim()}`)
    .join('\n');
}
