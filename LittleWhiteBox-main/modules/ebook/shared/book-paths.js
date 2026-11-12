import { isSupportedPublicTextPath } from '../../agent-core/tools/text-file-types.js';

export const BOOK_PATH_PREFIX = 'book/';

const FORBIDDEN_PREFIXES = [
    'local/',
    'scripts/',
    'modules/',
    'core/',
    'shared/',
    'libs/',
    'user/',
    'characters/',
    'worlds/',
];

function normalizeSlashes(value = '') {
    return String(value || '').trim().replace(/\\/g, '/');
}

export function normalizeBookPath(rawPath = '') {
    const normalized = normalizeSlashes(rawPath).replace(/^\/+/, '');
    if (!normalized || normalized === 'book') return BOOK_PATH_PREFIX;
    if (!normalized.startsWith(BOOK_PATH_PREFIX)) return '';
    if (normalized.includes('\0')) return '';
    if (normalized.includes('://')) return '';
    if (/^[a-z]:/i.test(normalized)) return '';
    if (normalized.split('/').some((segment) => segment === '..')) return '';
    return normalized.replace(/\/{2,}/g, '/');
}

export function normalizeBookDirectoryPath(rawPath = '') {
    const normalized = normalizeBookPath(rawPath);
    if (!normalized) return '';
    return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

export function normalizeBookFilePath(rawPath = '') {
    const normalized = normalizeBookPath(rawPath).replace(/\/+$/, '');
    if (!normalized || normalized === 'book') return '';
    if (FORBIDDEN_PREFIXES.some((prefix) => normalized.startsWith(prefix) && !normalized.startsWith(BOOK_PATH_PREFIX))) {
        return '';
    }
    if (!normalized.startsWith(BOOK_PATH_PREFIX)) return '';
    if (!isSupportedPublicTextPath(normalized)) return '';
    return normalized;
}

export function getBookPathError(rawPath = '', { directory = false } = {}) {
    const text = normalizeSlashes(rawPath);
    if (!text) return 'book_path_required';
    if (!text.replace(/^\/+/, '').startsWith(BOOK_PATH_PREFIX) && text.replace(/^\/+/, '') !== 'book') {
        return 'book_path_required';
    }
    if (text.includes('://') || /^[a-z]:/i.test(text) || text.split('/').some((segment) => segment === '..')) {
        return 'book_path_forbidden';
    }
    if (directory) {
        return normalizeBookDirectoryPath(text) ? '' : 'book_path_required';
    }
    if (text.endsWith('/')) return 'book_file_required';
    if (!normalizeBookFilePath(text)) return 'unsupported_text_file';
    return '';
}

export function assertBookFilePath(rawPath = '') {
    const normalized = normalizeBookFilePath(rawPath);
    if (!normalized) {
        throw new Error(getBookPathError(rawPath) || 'book_path_required');
    }
    return normalized;
}

export function assertBookDirectoryPath(rawPath = '') {
    const normalized = normalizeBookDirectoryPath(rawPath);
    if (!normalized) {
        throw new Error(getBookPathError(rawPath, { directory: true }) || 'book_path_required');
    }
    return normalized;
}

export function getParentDirectory(path = '') {
    const normalized = normalizeBookPath(path).replace(/\/+$/, '');
    if (!normalized || normalized === 'book') return '';
    const parts = normalized.split('/').filter(Boolean);
    parts.pop();
    return parts.length ? `${parts.join('/')}/` : BOOK_PATH_PREFIX;
}

export function getFileName(path = '') {
    return normalizeBookPath(path).replace(/\/+$/, '').split('/').filter(Boolean).pop() || '';
}
