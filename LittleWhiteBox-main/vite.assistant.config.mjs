import path from 'node:path';
import { defineConfig } from 'vite';

const NORMALIZED_WHITESPACE_LITERAL = JSON.stringify(' \n\r\t');

export default defineConfig({
    plugins: [{
        name: 'strip-retry-deprecation-logs',
        transform(code, id) {
            const normalizedId = id.replace(/\\/g, '/');
            if (!normalizedId.includes('/retry/lib/retry_operation.js')) {
                return null;
            }
            return {
                code: code
                    .replace("  console.log('Using RetryOperation.try() is deprecated');\n", '')
                    .replace("  console.log('Using RetryOperation.start() is deprecated');\n", ''),
                map: null,
            };
        },
        generateBundle(_, bundle) {
            const assistantChunk = bundle['assistant-app.js'];
            if (assistantChunk?.type !== 'chunk') return;
            // Keep the emitted runtime value identical while avoiding a template literal
            // that leaves trailing whitespace in the built artifact.
            assistantChunk.code = assistantChunk.code.replace(/` \r?\n\\r\t`/g, NORMALIZED_WHITESPACE_LITERAL);
        },
    }],
    build: {
        emptyOutDir: false,
        outDir: path.resolve('modules/assistant/dist'),
        lib: {
            entry: path.resolve('modules/assistant/app-src/main.js'),
            formats: ['es'],
            fileName: () => 'assistant-app.js',
        },
        rollupOptions: {
            output: {
                manualChunks: undefined,
            },
        },
        modulePreload: false,
        cssCodeSplit: false,
        ...(/** @type {const} */ ({ codeSplitting: false })),
        target: 'es2022',
        minify: 'esbuild',
        sourcemap: false,
    },
});
