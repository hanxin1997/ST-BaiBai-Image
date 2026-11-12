import { applyPatchUpdateToText } from './apply-patch.js';

function normalizeValidationState(validation = {}) {
    return {
        operationsValidated: Math.max(0, Number(validation.operationsValidated) || 0),
        hunksValidated: Math.max(0, Number(validation.hunksValidated) || 0),
    };
}

function attachValidationState(error, validation = {}) {
    const normalizedValidation = normalizeValidationState(validation);
    if (error instanceof Error) {
        error.patchValidation = normalizedValidation;
        return error;
    }
    const wrapped = new Error(String(error || 'unknown_error'));
    wrapped.patchValidation = normalizedValidation;
    return wrapped;
}

function normalizeChangeEntry(change = {}) {
    return {
        action: String(change.action || '').trim(),
        path: String(change.path || '').trim(),
        fromPath: String(change.fromPath || '').trim(),
        toPath: String(change.toPath || '').trim(),
        hunksApplied: Math.max(0, Number(change.hunksApplied) || 0),
    };
}

function buildSuccessSummary({
    filesChanged = 0,
    addedCount = 0,
    updatedCount = 0,
    deletedCount = 0,
    movedCount = 0,
    hunksApplied = 0,
    validation = {},
} = {}) {
    const parts = [
        `已先校验再应用补丁：共改动 ${filesChanged} 个文件`,
        `新增 ${addedCount}`,
        `更新 ${updatedCount}`,
        `删除 ${deletedCount}`,
        `移动 ${movedCount}`,
        `应用 ${hunksApplied} 个 hunk`,
        `校验了 ${validation.operationsValidated || 0} 个操作`,
    ];
    return parts.join('，') + '。';
}

function buildFailureSummary(errorMessage = '') {
    const normalized = String(errorMessage || '').trim().toLowerCase();
    if (normalized.startsWith('apply_patch_parse_error:')) {
        return 'Patch 解析失败，未修改任何文件。';
    }
    return 'Patch 校验失败，未修改任何文件。';
}

function buildFailureRecovery(errorMessage = '') {
    const normalized = String(errorMessage || '').trim().toLowerCase();
    const readFirstStep = '先 Read 目标文件当前内容，再用当前文件里真实存在的原文行重写 patchText；不要凭记忆或旧内容匹配。';

    if (normalized.startsWith('apply_patch_parse_error:')) {
        return {
            kind: 'parse_error',
            readBeforeRetry: false,
            nextStep: '重新生成完整 patchText：必须从 `*** Begin Patch` 开始，以 `*** End Patch` 结束，中间包含 `*** Update/Add/Delete File: ...` 文件操作。',
            rules: [
                'Update hunk 使用 `@@` 或 `@@ 当前文件中的锚点行`。',
                'hunk 内容行必须以空格、`-` 或 `+` 开头。',
                '不要传 JSON、sed、XML 或普通 unified diff 外壳。',
            ],
        };
    }

    if (normalized.includes('has no match context')) {
        return {
            kind: 'missing_match_context',
            readBeforeRetry: true,
            nextStep: readFirstStep,
            rules: [
                'Update hunk 不能只有新增行，必须至少包含一行当前文件已有的上下文行或删除行。',
                '如果只是插入内容，先 Read 插入点附近原文，把插入点前后的原句作为上下文。',
            ],
        };
    }

    if (normalized.includes('ambiguous')) {
        return {
            kind: 'ambiguous_match',
            readBeforeRetry: true,
            nextStep: readFirstStep,
            rules: [
                '增加更多相邻原文上下文，让旧块只匹配一个位置。',
                '或使用 `@@ 当前文件中唯一存在的锚点行` 限定 hunk 范围。',
            ],
        };
    }

    if (normalized.includes('old block did not match')
        || normalized.includes('header matched but old block did not match')
        || normalized.includes('header did not match')
        || normalized.includes('missing_block_match')
        || normalized.includes('missing_header_anchor')
        || normalized.includes('header_anchor_without_block')) {
        return {
            kind: 'stale_or_imprecise_context',
            readBeforeRetry: true,
            nextStep: readFirstStep,
            rules: [
                '复制 Read 返回的当前原文作为空格上下文行和 `-` 删除行。',
                '不要改写空格上下文行的标点、缩进、空白或全半角字符。',
                '如果使用 `@@ 锚点`，锚点必须是当前文件里真实存在且足够唯一的原文。',
            ],
        };
    }

    if (normalized.includes('file_not_found') || normalized.includes('path_required') || normalized.includes('destination_exists')) {
        return {
            kind: 'path_or_destination_error',
            readBeforeRetry: true,
            nextStep: '先用 LS / Glob 确认目标路径，再 Read 要修改的现有文件；确认路径和内容后重新生成 patchText。',
            rules: [
                'Update/Delete 的目标文件必须已经存在。',
                'Add 的目标文件不能已经存在。',
                '路径必须使用当前工具要求的工作区前缀。',
            ],
        };
    }

    return {
        kind: 'patch_failed',
        readBeforeRetry: true,
        nextStep: readFirstStep,
        rules: [
            '重新尝试前先确认目标文件路径和当前内容。',
            '小范围修改用当前原文精确上下文；大段正文、整节或整章重写改用 Write 写回完整文件。',
        ],
    };
}

function buildChangedPathSet(changes = []) {
    return new Set(
        (Array.isArray(changes) ? changes : [])
            .flatMap((change) => [change.path, change.fromPath, change.toPath])
            .filter(Boolean),
    );
}

function resolveMutationNextState(result = {}) {
    if (Object.prototype.hasOwnProperty.call(result || {}, 'nextState')) {
        return result.nextState;
    }
    if (Object.prototype.hasOwnProperty.call(result || {}, 'nextSources')) {
        return result.nextSources;
    }
    throw new Error('patch_adapter_missing_next_state');
}

export function buildPatchFailureResult(error) {
    const rawError = error instanceof Error ? error.message : String(error || 'unknown_error');
    const validation = normalizeValidationState(error?.patchValidation);
    const recovery = buildFailureRecovery(rawError);
    return {
        ok: false,
        phase: 'failed',
        summary: buildFailureSummary(rawError),
        nextStep: recovery.nextStep,
        recovery,
        filesChanged: 0,
        addedCount: 0,
        updatedCount: 0,
        deletedCount: 0,
        movedCount: 0,
        hunksApplied: 0,
        changes: [],
        validation,
        error: rawError,
    };
}

export function simulatePatchExecution(parsedPatch, initialState, adapter = {}) {
    const cloneState = typeof adapter.cloneState === 'function'
        ? adapter.cloneState
        : (state) => state;
    const normalizePath = typeof adapter.normalizePath === 'function'
        ? adapter.normalizePath
        : (path) => String(path || '').trim();
    const getPathError = typeof adapter.getPathError === 'function'
        ? adapter.getPathError
        : () => '';
    const findFile = typeof adapter.findFile === 'function'
        ? adapter.findFile
        : () => null;
    const addFile = typeof adapter.addFile === 'function'
        ? adapter.addFile
        : (() => {
            throw new Error('patch_adapter_add_missing');
        });
    const removeFile = typeof adapter.removeFile === 'function'
        ? adapter.removeFile
        : (() => {
            throw new Error('patch_adapter_remove_missing');
        });
    const moveFile = typeof adapter.moveFile === 'function'
        ? adapter.moveFile
        : (() => {
            throw new Error('patch_adapter_move_missing');
        });
    const writeFile = typeof adapter.writeFile === 'function'
        ? adapter.writeFile
        : addFile;
    const applyUpdate = typeof adapter.applyUpdate === 'function'
        ? adapter.applyUpdate
        : (content, hunks, options) => applyPatchUpdateToText(content, hunks, options);

    let nextState = cloneState(initialState);
    const changes = [];
    let hunksApplied = 0;
    let addedCount = 0;
    let updatedCount = 0;
    let deletedCount = 0;
    let movedCount = 0;
    const validation = {
        operationsValidated: 0,
        hunksValidated: 0,
    };

    try {
        (parsedPatch?.operations || []).forEach((operation) => {
            if (operation.type === 'add') {
                const targetPath = normalizePath(operation.path);
                if (!targetPath) {
                    throw new Error(getPathError(operation.path) || 'local_path_required');
                }
                if (findFile(nextState, targetPath)) {
                    throw new Error('local_destination_exists');
                }
                const addResult = addFile(nextState, targetPath, operation.content);
                nextState = resolveMutationNextState(addResult);
                changes.push(normalizeChangeEntry({
                    action: 'add',
                    path: addResult.file?.publicPath || targetPath,
                }));
                addedCount += 1;
                validation.operationsValidated += 1;
                return;
            }

            if (operation.type === 'delete') {
                const targetPath = normalizePath(operation.path);
                if (!targetPath) {
                    throw new Error(getPathError(operation.path) || 'local_path_required');
                }
                const removal = removeFile(nextState, targetPath);
                nextState = resolveMutationNextState(removal);
                changes.push(normalizeChangeEntry({
                    action: 'delete',
                    path: removal.file?.publicPath || targetPath,
                }));
                deletedCount += 1;
                validation.operationsValidated += 1;
                return;
            }

            const sourcePath = normalizePath(operation.path);
            if (!sourcePath) {
                throw new Error(getPathError(operation.path) || 'local_path_required');
            }
            const existingEntry = findFile(nextState, sourcePath);
            if (!existingEntry) {
                throw new Error('local_file_not_found');
            }

            let targetPath = sourcePath;
            if (operation.moveTo) {
                targetPath = normalizePath(operation.moveTo);
                if (!targetPath) {
                    throw new Error(getPathError(operation.moveTo) || 'local_path_required');
                }
                if (targetPath !== sourcePath) {
                    const move = moveFile(nextState, sourcePath, targetPath, { overwrite: false });
                    nextState = resolveMutationNextState(move);
                    movedCount += 1;
                    changes.push(normalizeChangeEntry({
                        action: 'move',
                        path: move.file?.publicPath || targetPath,
                        fromPath: move.fromFile?.publicPath || sourcePath,
                        toPath: move.file?.publicPath || targetPath,
                    }));
                }
            }

            if (!operation.hunks.length) {
                validation.operationsValidated += 1;
                return;
            }

            const currentEntry = findFile(nextState, targetPath);
            if (!currentEntry) {
                throw new Error('local_file_not_found');
            }
            const applied = applyUpdate(currentEntry.content, operation.hunks, { path: targetPath });
            hunksApplied += applied.hunksApplied;
            validation.hunksValidated += operation.hunks.length;

            const update = writeFile(nextState, targetPath, applied.content);
            nextState = resolveMutationNextState(update);
            updatedCount += 1;
            changes.push(normalizeChangeEntry({
                action: 'update',
                path: update.file?.publicPath || targetPath,
                fromPath: sourcePath !== (update.file?.publicPath || targetPath) ? sourcePath : '',
                hunksApplied: applied.hunksApplied,
            }));
            validation.operationsValidated += 1;
        });
    } catch (error) {
        throw attachValidationState(error, validation);
    }

    const filesChanged = buildChangedPathSet(changes).size;
    return {
        nextState,
        filesChanged,
        addedCount,
        updatedCount,
        deletedCount,
        movedCount,
        hunksApplied,
        changes,
        validation,
    };
}

export function runPatchValidationAndApply(parsedPatch, initialState, adapter = {}) {
    const validationRun = simulatePatchExecution(parsedPatch, initialState, adapter);
    let applyRun = null;
    try {
        applyRun = simulatePatchExecution(parsedPatch, initialState, adapter);
    } catch (error) {
        throw attachValidationState(error, validationRun.validation);
    }

    return {
        ok: true,
        phase: 'applied',
        summary: buildSuccessSummary({
            filesChanged: applyRun.filesChanged,
            addedCount: applyRun.addedCount,
            updatedCount: applyRun.updatedCount,
            deletedCount: applyRun.deletedCount,
            movedCount: applyRun.movedCount,
            hunksApplied: applyRun.hunksApplied,
            validation: validationRun.validation,
        }),
        filesChanged: applyRun.filesChanged,
        addedCount: applyRun.addedCount,
        updatedCount: applyRun.updatedCount,
        deletedCount: applyRun.deletedCount,
        movedCount: applyRun.movedCount,
        hunksApplied: applyRun.hunksApplied,
        changes: applyRun.changes.map(normalizeChangeEntry),
        validation: normalizeValidationState(validationRun.validation),
        nextState: applyRun.nextState,
    };
}
