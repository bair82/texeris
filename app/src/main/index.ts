import { app, BrowserWindow, safeStorage, session } from 'electron';
import path from 'node:path';
import { registerIpcHandlers, projectInfo } from './ipc';
import { DocChannels } from '../shared/doc-types';
import { PatchChannels } from '../shared/patch-types';
import { ProjectChannels } from '../shared/project-types';
import { PiAgentRuntime } from './agent/runtime';
import { createAppModels, createFauxModels } from './agent/models';
import { ConversationService } from './services/conversation';
import { CredentialsService } from './services/credentials';
import { openDevProject } from './services/devProject';
import { PatchService } from './services/patch';
import type { ProjectContext } from './services/project';
import { ProjectManager } from './services/projectManager';
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
  // Smoke runs (TEXERIS_SMOKE) stay hidden — never steal the user's focus.
  const smoke = Boolean(process.env.TEXERIS_SMOKE);
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    skipTaskbar: smoke,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Diagnostic mode: render visibly (so Chromium spellchecks + screenshots
  // work) without stealing focus.
  if (process.env.TEXERIS_SHOW_INACTIVE) {
    win.on('ready-to-show', () => {
      win.showInactive();
    });
  } else if (!smoke) {
    win.on('ready-to-show', () => {
      win.show();
    });
  }

  // electron-vite exposes the dev server URL via this env var in dev mode.
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  assertNodeVersion();

  // TEXERIS_FAUX_PROVIDER=1 swaps real providers for a scripted one (offline).
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
  const manager = new ProjectManager();

  // Spellcheck preference (M1.5 EU4). Chromium downloads the language
  // dictionary lazily on first enable (into <userData>/Dictionaries).
  // Re-apply when a page is ready: on Linux the checker only "arms" for
  // editable content that exists at apply time, so the boot-time apply
  // alone leaves the first page unchecked (docs/spellcheck-notes.md).
  const applySpellcheck = () => {
    session.defaultSession.setSpellCheckerEnabled(config.spellcheck.enabled);
    if (config.spellcheck.enabled) {
      const available = session.defaultSession.availableSpellCheckerLanguages;
      const language = available.includes(config.spellcheck.language)
        ? config.spellcheck.language
        : (available[0] ?? 'en-US');
      session.defaultSession.setSpellCheckerLanguages([language]);
    }
  };
  applySpellcheck();
  app.on('web-contents-created', (_event, contents) => {
    contents.on('did-finish-load', () => {
      applySpellcheck();
      // and once more shortly after — the arming races page setup
      setTimeout(applySpellcheck, 3000);
    });
  });

  let runtime: PiAgentRuntime | null = null;
  let conversations: ConversationService | null = null;
  let patches: PatchService | null = null;
  let stopWatcher: (() => void) | null = null;

  const broadcast = (channel: string, payload: unknown) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, payload);
    }
  };

  /** Bind a project context: (re)build per-project services and watchers. */
  const adoptProject = (ctx: ProjectContext): void => {
    conversations = new ConversationService(ctx.db);
    patches = new PatchService(ctx.db, ctx.revisions, (patchId, title) => {
      broadcast(PatchChannels.event, { type: 'patch-proposed', patchId, title });
    });
    if (runtime) {
      runtime.setProject(ctx, conversations, patches);
    } else {
      runtime = new PiAgentRuntime({
        models,
        config,
        conversations,
        project: ctx,
        patches,
        credentials,
      });
    }
    stopWatcher?.();
    stopWatcher = watchProjectFiles(ctx, (docEvent) => {
      broadcast(DocChannels.event, docEvent);
    });
    broadcast(ProjectChannels.changed, projectInfo(ctx));
  };

  const requireProject = (): ProjectContext => {
    if (!manager.current) {
      throw new Error('no project open');
    }
    return manager.current;
  };
  const requireRuntime = (): PiAgentRuntime => {
    if (!runtime) {
      throw new Error('no project open');
    }
    return runtime;
  };
  const requireConversations = (): ConversationService => {
    if (!conversations) {
      throw new Error('no project open');
    }
    return conversations;
  };
  const requirePatches = (): PatchService => {
    if (!patches) {
      throw new Error('no project open');
    }
    return patches;
  };

  registerIpcHandlers({
    requireProject,
    requireRuntime,
    requireConversations,
    requirePatches,
    credentials,
    config,
    manager,
    adoptProject,
  });

  // Boot project: smoke/dev override → most recent project → picker.
  if (process.env.TEXERIS_PROJECT_DIR) {
    adoptProject(manager.adoptContext(openDevProject()));
  } else {
    const [recent] = manager.recents();
    if (recent) {
      try {
        adoptProject(manager.open(recent));
      } catch (err) {
        console.error('failed to open recent project, showing picker', err);
      }
    }
  }

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
