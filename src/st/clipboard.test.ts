import { afterEach, describe, expect, it, vi } from 'vitest';

import { copyText } from './clipboard';

function stubLegacyCopy(result = true) {
  const textArea = {
    value: '',
    style: {},
    setAttribute: vi.fn(),
    focus: vi.fn(),
    select: vi.fn(),
    setSelectionRange: vi.fn(),
    remove: vi.fn(),
  };
  const appendChild = vi.fn();
  const execCommand = vi.fn(() => result);

  vi.stubGlobal('document', {
    body: { appendChild },
    createElement: vi.fn(() => textArea),
    execCommand,
  });

  return { textArea, appendChild, execCommand };
}

afterEach(() => vi.unstubAllGlobals());

describe('copyText', () => {
  it('在非安全上下文回退到 textarea 复制', async () => {
    const { textArea, appendChild, execCommand } = stubLegacyCopy();
    const success = vi.fn();
    const error = vi.fn();
    vi.stubGlobal('window', { isSecureContext: false });
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('toastr', { success, error });

    await expect(copyText('手机端文本')).resolves.toBe(true);
    expect(textArea.value).toBe('手机端文本');
    expect(appendChild).toHaveBeenCalledWith(textArea);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(textArea.remove).toHaveBeenCalled();
    expect(success).toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('异步 Clipboard 被拒绝时也尝试回退', async () => {
    const { execCommand } = stubLegacyCopy();
    const writeText = vi.fn().mockRejectedValue(new DOMException('denied'));
    vi.stubGlobal('window', { isSecureContext: true });
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('toastr', { success: vi.fn(), error: vi.fn() });

    await expect(copyText('fallback')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('fallback');
    expect(execCommand).toHaveBeenCalledWith('copy');
  });
});
