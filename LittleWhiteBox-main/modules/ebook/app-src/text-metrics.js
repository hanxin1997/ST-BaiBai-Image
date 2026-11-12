export function estimateTextTokens(text = '') {
    const normalized = String(text || '').trim();
    if (!normalized) return 0;
    const cjkChars = normalized.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length || 0;
    const latinWords = normalized.match(/[A-Za-z0-9_]+(?:[-'][A-Za-z0-9_]+)*/g)?.length || 0;
    const otherChars = normalized
        .replace(/[\u3400-\u9fff\uf900-\ufaff]/g, '')
        .replace(/[A-Za-z0-9_]+(?:[-'][A-Za-z0-9_]+)*/g, '')
        .replace(/\s+/g, '').length;
    return Math.max(1, Math.ceil(cjkChars + latinWords * 1.3 + otherChars / 3));
}

export function getTextMetrics(text = '') {
    const value = String(text || '');
    const trimmed = value.trim();
    return {
        chars: trimmed.length,
        lines: trimmed ? value.replace(/\r\n?/g, '\n').split('\n').length : 0,
        tokens: estimateTextTokens(value),
    };
}

export function formatTextMetrics(text = '') {
    const metrics = getTextMetrics(text);
    return `${metrics.chars} 字 · ${metrics.lines} 行`;
}

export function formatDraftMetrics(text = '') {
    const metrics = getTextMetrics(text);
    const pages = metrics.chars ? Math.max(1, Math.ceil(metrics.chars / 800)) : 0;
    return `${metrics.chars} 字 · ${metrics.lines} 行 · 约 ${pages} 页`;
}
