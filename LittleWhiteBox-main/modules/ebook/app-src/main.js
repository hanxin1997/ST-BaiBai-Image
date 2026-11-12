import { EBOOK_ROOT_ID } from './constants.js';
import { createEbookApp } from './ebook-app.js';
import { createEbookHostBridge } from './host-bridge.js';

const hostBridge = createEbookHostBridge();
const app = createEbookApp({
    rootId: EBOOK_ROOT_ID,
    hostBridge,
});

hostBridge.start({
    onConfig: app.handleHostConfig,
    onOpenSettings: app.handleOpenSettings,
    onDrawProgress: app.handleDrawProgress,
    onTtsState: app.handleTtsState,
});

void app.start();
