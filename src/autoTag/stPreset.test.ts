import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutoTagSettings, ImportedPreset } from '@/state/settings';
import {
  parsePresetFile,
  readPresetEntries,
  resolveImportedJailbreak,
  resolveJailbreakPrompt,
  resolvePresetJailbreak,
} from './stPreset';

/**
 * 破限词的两种来源:
 * 1. 实时读酒馆当前聊天补全预设(只读,不写回);
 * 2. 读本插件导入的预设快照(静态副本,酒馆里改预设不影响它)。
 *
 * 两条来源共用同一套「勾选 ∩ 存在 ∩ 非空,按预设顺序拼接」的口径——
 * 这里同时钉住这个口径,以及「导入快照悬空 → 回退当前预设」的回退链。
 */

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

const presetSettings = {
  preset_settings_openai: 'Meowssiah-2.1.7',
  prompts: [
    { identifier: 'main', name: 'Main', content: 'Main prompt' },
    { identifier: 'jailbreak', name: 'Jailbreak', content: 'JB text for {{char}}' },
    { identifier: 'nsfw', name: 'NSFW', content: 'NSFW text' },
    { identifier: 'chatHistory', name: 'Chat History', marker: true },
    { identifier: 'orphan', name: 'Orphan', content: 'Orphan text' },
  ],
  prompt_order: [
    {
      character_id: 100001,
      order: [
        { identifier: 'main', enabled: true },
        { identifier: 'jailbreak', enabled: true },
        { identifier: 'nsfw', enabled: false },
        { identifier: 'chatHistory', enabled: true },
      ],
    },
  ],
};

function setContext(overrides: Record<string, any> = {}): void {
  mocks.context = {
    chatCompletionSettings: presetSettings,
    substituteParams: (text: string) => text.replace('{{char}}', 'Char'),
    ...overrides,
  };
}

function options(over: Partial<AutoTagSettings> = {}): AutoTagSettings {
  return {
    prompts: { jailbreak: '' },
    jailbreakSource: { mode: 'stPreset', presetEntries: ['jailbreak', 'nsfw'] },
    importedPresets: [],
    ...over,
  } as AutoTagSettings;
}

function importedPreset(over: Partial<ImportedPreset> = {}): ImportedPreset {
  return {
    id: 'imp_1',
    name: '导入的预设',
    sourceFile: '我即浪潮.json',
    importedAt: 1,
    entries: [
      { identifier: 'a', name: 'A', content: 'A text', enabled: true, inOrder: true, marker: false },
      { identifier: 'b', name: 'B', content: 'B text', enabled: true, inOrder: true, marker: false },
      { identifier: 'm', name: 'M', content: '', enabled: true, inOrder: true, marker: true },
    ],
    ...over,
  };
}

beforeEach(() => {
  setContext();
});

describe('readPresetEntries:顺序表 ∪ prompts,不丢条目', () => {
  it('按顺序表排列,再补顺序表里没有的条目', () => {
    const entries = readPresetEntries(presetSettings as any);
    expect(entries.map(entry => entry.identifier)).toEqual([
      'main',
      'jailbreak',
      'nsfw',
      'chatHistory',
      'orphan',
    ]);
    expect(entries.find(entry => entry.identifier === 'orphan')).toMatchObject({ inOrder: false });
    expect(entries.find(entry => entry.identifier === 'nsfw')).toMatchObject({ enabled: false });
    expect(entries.find(entry => entry.identifier === 'chatHistory')).toMatchObject({
      marker: true,
    });
  });

  it('没有设置对象 → 空数组', () => {
    expect(readPresetEntries(undefined)).toEqual([]);
  });
});

describe('resolvePresetJailbreak:实时预设', () => {
  it('按预设顺序拼接,不按勾选顺序', () => {
    expect(resolvePresetJailbreak(['nsfw', 'jailbreak'])).toBe('JB text for Char\n\nNSFW text');
  });

  it('空内容/占位项即使勾选也不产生文本', () => {
    expect(resolvePresetJailbreak(['chatHistory'])).toBe('');
  });

  it('酒馆上下文缺失 → 空串(由调用方回退)', () => {
    mocks.context = null;
    expect(resolvePresetJailbreak(['jailbreak'])).toBe('');
  });
});

describe('parsePresetFile:导入预设文件', () => {
  it('标准预设:名字取 preset_settings_openai,条目与实时预设同构', () => {
    const parsed = parsePresetFile(presetSettings, '随便.json');
    expect(parsed.name).toBe('Meowssiah-2.1.7');
    expect(parsed.entries.map(entry => entry.identifier)).toEqual([
      'main',
      'jailbreak',
      'nsfw',
      'chatHistory',
      'orphan',
    ]);
  });

  it('预设没自报名字 → 用文件名', () => {
    const parsed = parsePresetFile({ ...presetSettings, preset_settings_openai: '' }, '我即浪潮-1121.json');
    expect(parsed.name).toBe('我即浪潮-1121');
  });

  it('世界书 JSON / 无关 JSON → 明确报错,而不是给一份空预设', () => {
    expect(() => parsePresetFile({ entries: { 0: { content: 'x' } } }, '书.json')).toThrow(/prompts/);
    expect(() => parsePresetFile(null, 'x.json')).toThrow();
    expect(() => parsePresetFile([], 'x.json')).toThrow();
  });

  it('有 prompts 但全是空条目 → 报错', () => {
    expect(() => parsePresetFile({ prompts: [] }, 'x.json')).toThrow(/提示词条目/);
  });
});

describe('resolveJailbreakPrompt:回退链', () => {
  it('custom 模式:自定义文本优先,空则内置默认', () => {
    const custom = options({ prompts: { jailbreak: '我的文本' } as any, jailbreakSource: { mode: 'custom', presetEntries: [] } });
    expect(resolveJailbreakPrompt(custom, '内置')).toBe('我的文本');
    const empty = options({ prompts: { jailbreak: '   ' } as any, jailbreakSource: { mode: 'custom', presetEntries: [] } });
    expect(resolveJailbreakPrompt(empty, '内置')).toBe('内置');
  });

  it('stPreset + current:用实时预设', () => {
    expect(resolveJailbreakPrompt(options(), '内置')).toBe('JB text for Char\n\nNSFW text');
  });

  it('stPreset + imported:用快照,不读酒馆当前预设', () => {
    mocks.context = null; // 酒馆读不到也不影响导入快照
    const opts = options({
      jailbreakSource: { mode: 'stPreset', presetSource: 'imported', presetId: 'imp_1', presetEntries: ['b', 'a'] },
      importedPresets: [importedPreset()],
    });
    expect(resolveJailbreakPrompt(opts, '内置')).toBe('A text\n\nB text');
  });

  it('导入快照里取不到勾选条目 → 回退自定义/内置,不混入当前预设', () => {
    const opts = options({
      prompts: { jailbreak: '回退文本' } as any,
      jailbreakSource: { mode: 'stPreset', presetSource: 'imported', presetId: 'imp_1', presetEntries: ['zzz'] },
      importedPresets: [importedPreset()],
    });
    expect(resolveJailbreakPrompt(opts, '内置')).toBe('回退文本');
  });

  it('导入快照被删(悬空 id)→ 回退实时当前预设', () => {
    const opts = options({
      jailbreakSource: { mode: 'stPreset', presetSource: 'imported', presetId: 'imp_gone', presetEntries: ['jailbreak'] },
      importedPresets: [importedPreset()],
    });
    expect(resolveJailbreakPrompt(opts, '内置')).toBe('JB text for Char');
  });

  it('导入快照悬空且酒馆也读不到 → 回退自定义文本 → 内置默认', () => {
    mocks.context = null;
    const opts = options({
      jailbreakSource: { mode: 'stPreset', presetSource: 'imported', presetId: 'imp_gone', presetEntries: ['jailbreak'] },
      importedPresets: [],
    });
    expect(resolveJailbreakPrompt(opts, '内置')).toBe('内置');
  });
});

describe('resolveImportedJailbreak:纯函数', () => {
  it('preset 不存在 → found=false', () => {
    expect(resolveImportedJailbreak([importedPreset()], 'nope', ['a'])).toEqual({
      found: false,
      text: '',
    });
  });

  it('preset 存在但没勾中任何条目 → found=true,text 空', () => {
    expect(resolveImportedJailbreak([importedPreset()], 'imp_1', ['zzz'])).toEqual({
      found: true,
      text: '',
    });
  });
});
