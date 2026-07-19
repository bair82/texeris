import { app, BrowserWindow, safeStorage } from 'electron';
import path from 'node:path';
import { registerIpcHandlers } from './ipc';
import { DocChannels } from '../shared/doc-types';
import { PatchChannels } from '../shared/patch-types';
import { PiAgentRuntime } from './agent/runtime';
import { createAppModels, createFauxModels } from './agent/models';
import { ConversationService } from './services/conversation';
import { CredentialsService } from './services/credentials';
import { openDevProject } from './services/devProject';
import { PatchService } from './services/patch';
import { loadWorkspaceConfig, type WorkspaceConfig } from './services/settings';
import { watchProjectFiles } from './services/watcher';
import type { Models } from '@earendil-works/pi-ai';

/** Pi requires Node >= 22.19; assert the Electron-bundled Node at startup. */
const MIN_NODE_VERSION = [22, 19, 0] as const;

// Linux (e.g. Omarchy/Hyprland): Electron's safeStorage backend
// auto-detection can fail without a GNOME/KDE desktop session even when
// gnome-keyring is running — select libsecret explicitly.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
}

function assertNodeVersion(): void {
  const current = process.versions.node.split('.').map(Number) as [
    number,
    number,
    number,
  ];
  const [major, minor, patch] = current;
  const [minMajor, minMinor, minPatch] = MIN_NODE_VERSION;
  const ok =
    major > minMajor ||
    (major === minMajor &&
      (minor > minMinor || (minor === minMinor && patch >= minPatch)));
  if (!ok) {
    console.error(
      `Texeris requires Electron with bundled Node >= ${MIN_NODE_VERSION.join('.')} ` +
        `(this build bundles ${process.versions.node}). Refusing to start.`,
    );
    app.exit(1);
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.on('ready-to-show', () => {
    win.show();
  });

  // electron-vite exposes the dev server URL via this env var in dev mode.
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  assertNodeVersion();

  // WP3 wiring: dev project + conversation persistence + agent runtime.
  // TEXERIS_FAUX_PROVIDER=1 swaps real providers for a scripted one (offline).
  const project = openDevProject();
  const conversations = new ConversationService(project.db);
  const patches = new PatchService(project.db, project.revisions, (patchId, title) => {
    // patch.proposed push (plan §9): open the review UI in every window.
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(PatchChannels.event, { type: 'patch-proposed', patchId, title });
    }
  });
  let models: Models;
  let config: WorkspaceConfig;
  if (process.env.TEXERIS_FAUX_PROVIDER) {
    ({ models, config } = createFauxModels(
      'This is a scripted offline response. The chat loop works.',
    ));
  } else {
    models = createAppModels();
    config = loadWorkspaceConfig();
  }
  const credentials = new CredentialsService(safeStorage);
  const runtime = new PiAgentRuntime({
    models,
    config,
    conversations,
    project,
    patches,
    credentials,
  });
  registerIpcHandlers({ runtime, conversations, project, patches, credentials, config });

  // External edits (plan §8): import + notify all windows.
  watchProjectFiles(project, (docEvent) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(DocChannels.event, docEvent);
    }
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
