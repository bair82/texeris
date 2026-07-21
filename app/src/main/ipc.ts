import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import path from 'node:path';
import { Value } from '@sinclair/typebox/value';
import {
  AppInfoSchema,
  IpcChannels,
  type AppInfo,
} from '../shared/ipc-contract';
import {
  CancelRequestSchema,
  ChatChannels,
  ConversationRequestSchema,
  RenameConversationRequestSchema,
  StartTurnRequestSchema,
} from '../shared/chat-types';
import {
  CheckpointCreateRequestSchema,
  CheckpointListRequestSchema,
  CheckpointRestoreRequestSchema,
  DocChannels,
  DocCommitRequestSchema,
  DocCreateRequestSchema,
  DocGetTextRequestSchema,
  DocIdRequestSchema,
  DocOutlineRequestSchema,
  DocRenameRequestSchema,
  DocRevisionsRequestSchema,
  HistoryChannels,
} from '../shared/doc-types';
import {
  PatchAcceptRequestSchema,
  PatchChannels,
  PatchGetRequestSchema,
  PatchRejectRequestSchema,
  DocRestoreRequestSchema,
} from '../shared/patch-types';
import {
  ProjectChannels,
  ProjectCreateRequestSchema,
  ProjectOpenPathRequestSchema,
  type ProjectInfo,
} from '../shared/project-types';
import {
  ClearApiKeyRequestSchema,
  SetApiKeyRequestSchema,
  SetAppearanceRequestSchema,
  SetSpellcheckRequestSchema,
  SetPatchStyleModeRequestSchema,
  SettingsChannels,
  type AppearanceConfig,
  type SettingsView,
} from '../shared/settings-types';
import { UiChannels, UiStateSchema } from '../shared/ui-types';
import type { AgentRuntime } from './agent/runtime';
import { UiStateService } from './services/uiState';
import type { ConversationService } from './services/conversation';
import { CredentialsService } from './services/credentials';
import { CheckpointService } from './services/checkpoint';
import type { PatchService } from './services/patch';
import type { ProjectContext } from './services/project';
import type { ProjectManager } from './services/projectManager';
import type { WorkspaceConfig } from './services/settings';
import { saveWorkspaceConfig } from './services/settings';
import { extractHeadings } from './agent/markdown';
import {
  deleteTrashedDocument,
  duplicateDocument,
  exportDocumentFile,
  importDocumentFile,
  listTrashedDocuments,
  renameDocument,
  restoreDocument,
  setMainDocument,
  trashDocument,
} from './services/documents';
import { createDocument, ensureDocument } from './services/project';
import { ProfileBeginRequestSchema, ProfileChannels } from '../shared/profile-types';
import type { CorpusService } from './services/corpus';
import type { WritingProfileService } from './services/profile';

export interface IpcDeps {
  requireProject(): ProjectContext;
  requireRuntime(): AgentRuntime;
  requireConversations(): ConversationService;
  requirePatches(): PatchService;
  credentials: CredentialsService;
  config: WorkspaceConfig;
  manager: ProjectManager;
  corpus: CorpusService;
  profiles: WritingProfileService;
  adoptProject(ctx: ProjectContext): void;
}

export function projectInfo(ctx: ProjectContext): ProjectInfo {
  return {
    root: ctx.root,
    projectId: ctx.project.projectId,
    mainDocument: ctx.project.mainDocument,
  };
}

function mainDocId(project: ProjectContext): string {
  return ensureDocument(project, project.project.mainDocument);
}

function docPath(project: ProjectContext, documentId: string): string {
  const row = project.db
    .prepare('SELECT path FROM documents WHERE id = ?')
    .get(documentId) as { path: string } | undefined;
  return row?.path ?? project.project.mainDocument;
}

export function registerIpcHandlers(deps: IpcDeps): void {
  ipcMain.handle(IpcChannels.getAppInfo, (): AppInfo => {
    const info: AppInfo = {
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
    };
    // Validate before the payload crosses the bridge — fail loudly in main
    // rather than letting a malformed payload reach the renderer.
    return Value.Decode(AppInfoSchema, info);
  });

  // ---------------------------------------------------------------- project

  ipcMain.handle(ProjectChannels.current, (): ProjectInfo | null =>
    deps.manager.current ? projectInfo(deps.manager.current) : null,
  );

  ipcMain.handle(ProjectChannels.recents, () => deps.manager.recents());

  ipcMain.handle(ProjectChannels.pickDirectory, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win!, {
      title: 'Choose a folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle(ProjectChannels.openDialog, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win!, {
      title: 'Open a Texeris project folder',
      properties: ['openDirectory'],
    });
    if (result.canceled) {
      return null;
    }
    const ctx = deps.manager.open(result.filePaths[0]);
    deps.adoptProject(ctx);
    return projectInfo(ctx);
  });

  ipcMain.handle(ProjectChannels.openPath, (_event, raw: unknown) => {
    const req = Value.Decode(ProjectOpenPathRequestSchema, raw);
    const ctx = deps.manager.open(req.path);
    deps.adoptProject(ctx);
    return projectInfo(ctx);
  });

  ipcMain.handle(ProjectChannels.create, (_event, raw: unknown) => {
    const req = Value.Decode(ProjectCreateRequestSchema, raw);
    const ctx = deps.manager.create(req.parentDir, req.name);
    deps.adoptProject(ctx);
    return projectInfo(ctx);
  });

  // ------------------------------------------------------------------- chat

  ipcMain.handle(ChatChannels.getOrCreateConversation, () => ({
    conversationId: deps.requireConversations().getOrCreateConversation(),
  }));

  ipcMain.handle(ChatChannels.newConversation, () => ({
    conversationId: deps.requireConversations().startNewConversation(),
  }));

  ipcMain.handle(ChatChannels.listConversations, () =>
    deps.requireConversations().listConversations(),
  );

  ipcMain.handle(ChatChannels.renameConversation, (_event, raw: unknown) => {
    const req = Value.Decode(RenameConversationRequestSchema, raw);
    deps.requireConversations().renameConversation(req.conversationId, req.title);
    return { renamed: true };
  });

  ipcMain.handle(ChatChannels.deleteConversation, (_event, raw: unknown) => {
    const req = Value.Decode(ConversationRequestSchema, raw);
    deps.requireConversations().deleteConversation(req.conversationId);
    return { deleted: true };
  });

  ipcMain.handle(ChatChannels.listMessages, (_event, raw: unknown) => {
    const req = Value.Decode(ConversationRequestSchema, raw);
    return deps.requireConversations().listUiMessages(req.conversationId);
  });

  ipcMain.handle(ChatChannels.listRuns, (_event, raw: unknown) => {
    const req = Value.Decode(ConversationRequestSchema, raw);
    return deps.requireConversations().listRuns(req.conversationId);
  });

  ipcMain.handle(ChatChannels.listDelegations, (_event, raw: unknown) => {
    const req = Value.Decode(ConversationRequestSchema, raw);
    return deps.requireConversations().listDelegations(req.conversationId);
  });

  ipcMain.handle(ChatChannels.startTurn, async (event, raw: unknown) => {
    const req = Value.Decode(StartTurnRequestSchema, raw);
    const { runId } = await deps.requireRuntime().startTurn(req);
    // Forward this run's events to the requesting window until the queue
    // closes (run end). Events originate in main — trusted, not re-validated.
    void (async () => {
      for await (const agentEvent of deps.requireRuntime().events(runId)) {
        if (!event.sender.isDestroyed()) {
          event.sender.send(ChatChannels.event, agentEvent);
        }
      }
    })();
    return { runId };
  });

  ipcMain.handle(ChatChannels.cancel, async (_event, raw: unknown) => {
    const req = Value.Decode(CancelRequestSchema, raw);
    await deps.requireRuntime().cancel(req.runId);
    return { cancelled: true };
  });

  // --------------------------------------------------------- writing profile

  ipcMain.handle(ProfileChannels.begin, async (event, raw: unknown) => {
    const req = Value.Decode(ProfileBeginRequestSchema, raw);
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win!, {
      title: req.source === 'folder' ? 'Choose writing corpus folder' : 'Choose writing files',
      properties: req.source === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'],
      filters: req.source === 'files'
        ? [{ name: 'Writing documents', extensions: ['md', 'markdown', 'mdown', 'txt', 'html', 'htm', 'docx', 'odt', 'rtf', 'pdf'] }]
        : undefined,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const conversations = deps.requireConversations();
    const conversationId = conversations.startNewConversation({ id: 'writing-profile', version: 1 });
    const grant = deps.corpus.createGrant(deps.requireProject(), conversationId, result.filePaths, req.source);
    const { runId } = await deps.requireRuntime().startTurn({
      conversationId,
      text: 'Analyze the selected corpus and build my writing profile. Begin by reviewing the corpus inventory and conversion warnings. Delegate bounded corpus-analysis and metadata tasks where useful. Ask me before any lookup involving an ambiguous or apparently private work.',
      mode: 'deep',
      scope: { kind: 'document', documentId: mainDocId(deps.requireProject()) },
    });
    void (async () => {
      for await (const agentEvent of deps.requireRuntime().events(runId)) {
        if (!event.sender.isDestroyed()) event.sender.send(ChatChannels.event, agentEvent);
      }
    })();
    return { conversationId, runId, sourceCount: grant.sources.length };
  });

  // -------------------------------------------------------------------- doc

  ipcMain.handle(DocChannels.list, () => {
    const rows = deps.requireProject().db
      .prepare(
        'SELECT id, path, title, current_revision, content_hash FROM documents WHERE trashed_at IS NULL ORDER BY path',
      )
      .all() as Array<{
      id: string;
      path: string;
      title: string;
      current_revision: number;
      content_hash: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      title: row.title,
      currentRevision: row.current_revision,
      contentHash: row.content_hash,
    }));
  });

  ipcMain.handle(DocChannels.outline, (_event, raw: unknown) => {
    const req = Value.Decode(DocOutlineRequestSchema, raw ?? {});
    const project = deps.requireProject();
    const docId = req.documentId ?? mainDocId(project);
    const text = project.revisions.getCurrentText(docId);
    return extractHeadings(text);
  });

  ipcMain.handle(DocChannels.getText, (_event, raw: unknown) => {
    const req = Value.Decode(DocGetTextRequestSchema, raw ?? {});
    const project = deps.requireProject();
    const docId = req.documentId ?? mainDocId(project);
    return {
      documentId: docId,
      path: docPath(project, docId),
      text: project.revisions.getCurrentText(docId),
      revision: project.revisions.getCurrentRevision(docId),
    };
  });

  /**
   * Editor commit (plan §8): grouped text changes arrive over IPC, are
   * validated against the current revision, applied to the canonical file
   * (atomic write) and recorded as one user revision. A validation failure
   * rejects the invoke — the file is untouched.
   */
  ipcMain.handle(DocChannels.commit, (_event, raw: unknown) => {
    const req = Value.Decode(DocCommitRequestSchema, raw);
    const project = deps.requireProject();
    const docId = req.documentId ?? mainDocId(project);
    const seq = project.revisions.commit(docId, req.splices, {
      actor: 'user',
      source: { kind: req.kind },
    });
    return { seq };
  });

  /** Restore an earlier revision as a new revision (undo path, §8). */
  ipcMain.handle(DocChannels.restore, (_event, raw: unknown) => {
    const req = Value.Decode(DocRestoreRequestSchema, raw);
    const project = deps.requireProject();
    const docId = req.documentId ?? mainDocId(project);
    const seq = project.revisions.restore(docId, req.revision);
    return { seq };
  });

  ipcMain.handle(DocChannels.create, (_event, raw: unknown) => {
    const req = Value.Decode(DocCreateRequestSchema, raw);
    return createDocument(deps.requireProject(), req.name);
  });

  // ---------------------------------------------------- document management

  ipcMain.handle(DocChannels.rename, (_event, raw: unknown) => {
    const req = Value.Decode(DocRenameRequestSchema, raw);
    return renameDocument(deps.requireProject(), req.documentId, req.name);
  });

  ipcMain.handle(DocChannels.trash, (_event, raw: unknown) => {
    const req = Value.Decode(DocIdRequestSchema, raw);
    trashDocument(deps.requireProject(), req.documentId);
    return { trashed: true };
  });

  ipcMain.handle(DocChannels.duplicate, (_event, raw: unknown) => {
    const req = Value.Decode(DocIdRequestSchema, raw);
    return duplicateDocument(deps.requireProject(), req.documentId);
  });

  ipcMain.handle(DocChannels.importDialog, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win!, {
      title: 'Import a document',
      filters: [
        { name: 'Supported documents', extensions: ['md', 'markdown', 'mdown', 'txt', 'docx', 'odt', 'rtf'] },
        { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'txt'] },
        { name: 'Word document', extensions: ['docx'] },
        { name: 'OpenDocument text', extensions: ['odt'] },
        { name: 'Rich Text Format', extensions: ['rtf'] },
      ],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return importDocumentFile(deps.requireProject(), result.filePaths[0]);
  });

  ipcMain.handle(DocChannels.exportDialog, async (event, raw: unknown) => {
    const req = Value.Decode(DocIdRequestSchema, raw);
    const project = deps.requireProject();
    const row = project.db.prepare('SELECT path, title FROM documents WHERE id = ?').get(req.documentId) as
      | { path: string; title: string }
      | undefined;
    if (!row) throw new Error('unknown document');
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(win!, {
      title: 'Export document',
      defaultPath: path.join(project.root, `${row.title}.docx`),
      filters: [
        { name: 'Word document', extensions: ['docx'] },
        { name: 'OpenDocument text', extensions: ['odt'] },
        { name: 'Rich Text Format', extensions: ['rtf'] },
        { name: 'Markdown', extensions: ['md'] },
      ],
    });
    if (result.canceled || !result.filePath) return null;
    return exportDocumentFile(project, req.documentId, result.filePath);
  });

  ipcMain.handle(DocChannels.setMain, (_event, raw: unknown) => {
    const req = Value.Decode(DocIdRequestSchema, raw);
    setMainDocument(deps.requireProject(), req.documentId);
    return projectInfo(deps.requireProject());
  });

  ipcMain.handle(DocChannels.reveal, (_event, raw: unknown) => {
    const req = Value.Decode(DocIdRequestSchema, raw);
    const project = deps.requireProject();
    shell.showItemInFolder(path.join(project.root, docPath(project, req.documentId)));
    return { revealed: true };
  });

  // ---------------------------------------------------------- trash (EU7)

  ipcMain.handle(DocChannels.trashList, () =>
    listTrashedDocuments(deps.requireProject()),
  );

  ipcMain.handle(DocChannels.restoreTrash, (_event, raw: unknown) => {
    const req = Value.Decode(DocIdRequestSchema, raw);
    return restoreDocument(deps.requireProject(), req.documentId);
  });

  ipcMain.handle(DocChannels.deleteTrash, (_event, raw: unknown) => {
    const req = Value.Decode(DocIdRequestSchema, raw);
    deleteTrashedDocument(deps.requireProject(), req.documentId);
    return { deleted: true };
  });

  // ---------------------------------------------------------------- history

  ipcMain.handle(HistoryChannels.revisions, (_event, raw: unknown) => {
    const req = Value.Decode(DocRevisionsRequestSchema, raw ?? {});
    const project = deps.requireProject();
    const docId = req.documentId ?? mainDocId(project);
    return project.revisions.listRevisions(docId, 200);
  });

  ipcMain.handle(HistoryChannels.checkpointList, (_event, raw: unknown) => {
    const req = Value.Decode(CheckpointListRequestSchema, raw ?? {});
    const project = deps.requireProject();
    const docId = req.documentId ?? mainDocId(project);
    return new CheckpointService(project.db, project.revisions).list(docId);
  });

  ipcMain.handle(HistoryChannels.checkpointCreate, (_event, raw: unknown) => {
    const req = Value.Decode(CheckpointCreateRequestSchema, raw);
    const project = deps.requireProject();
    const docId = req.documentId ?? mainDocId(project);
    return new CheckpointService(project.db, project.revisions).create(docId, req.name);
  });

  ipcMain.handle(HistoryChannels.checkpointRestore, (_event, raw: unknown) => {
    const req = Value.Decode(CheckpointRestoreRequestSchema, raw);
    const project = deps.requireProject();
    const seq = new CheckpointService(project.db, project.revisions).restore(req.checkpointId);
    return { seq };
  });

  // ------------------------------------------------------------------ patch

  ipcMain.handle(PatchChannels.list, (_event, raw: unknown) => {
    const req = Value.Decode(DocGetTextRequestSchema, raw ?? {});
    const project = deps.requireProject();
    const docId = req.documentId ?? ensureDocument(project, project.project.mainDocument);
    return deps.requirePatches().list(docId);
  });

  ipcMain.handle(PatchChannels.get, (_event, raw: unknown) => {
    const req = Value.Decode(PatchGetRequestSchema, raw);
    const patch = deps.requirePatches().get(req.patchId);
    if (!patch) {
      throw new Error(`unknown patch: ${req.patchId}`);
    }
    return patch;
  });

  ipcMain.handle(PatchChannels.accept, (_event, raw: unknown) => {
    const req = Value.Decode(PatchAcceptRequestSchema, raw);
    return deps.requirePatches().accept(req.patchId, req.groupIds);
  });

  ipcMain.handle(PatchChannels.reject, (_event, raw: unknown) => {
    const req = Value.Decode(PatchRejectRequestSchema, raw);
    deps.requirePatches().reject(req.patchId, req.groupIds);
    return { rejected: true };
  });

  // --------------------------------------------------------------- settings

  ipcMain.handle(SettingsChannels.get, (): SettingsView => {
    return {
      modes: deps.config.modes,
      providers: CredentialsService.knownProviders().map((id) => ({
        id,
        label: id === 'deepseek' ? 'DeepSeek' : 'Moonshot AI (Kimi)',
        keySource: deps.credentials.keySource(id),
      })),
      encryptionAvailable: deps.credentials.encryptionAvailable(),
      spellcheck: {
        enabled: deps.config.spellcheck.enabled,
        language: deps.config.spellcheck.language,
        availableLanguages: session.defaultSession.availableSpellCheckerLanguages,
      },
      appearance: deps.config.appearance,
      patchStyleMode: deps.config.patchStyleMode,
      writingProfile: deps.profiles.view(),
    };
  });

  /** Appearance prefs (M1.5 EU6): merge, persist, and broadcast so every
   * window repaints immediately — no reload. */
  ipcMain.handle(SettingsChannels.setAppearance, (_event, raw: unknown) => {
    const req = Value.Decode(SetAppearanceRequestSchema, raw);
    const appearance: AppearanceConfig = { ...deps.config.appearance, ...req };
    deps.config.appearance = appearance;
    if (!process.env.TEXERIS_FAUX_PROVIDER) saveWorkspaceConfig(deps.config);
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(SettingsChannels.appearanceChanged, appearance);
    }
    return appearance;
  });

  /** Spellcheck (M1.5 EU4): applied to the default session immediately and
   * persisted to the workspace config. */
  ipcMain.handle(SettingsChannels.setSpellcheck, (_event, raw: unknown) => {
    const req = Value.Decode(SetSpellcheckRequestSchema, raw);
    const available = session.defaultSession.availableSpellCheckerLanguages;
    const language = available.includes(req.language)
      ? req.language
      : (available[0] ?? 'en-US');
    session.defaultSession.setSpellCheckerEnabled(req.enabled);
    if (req.enabled) {
      session.defaultSession.setSpellCheckerLanguages([language]);
    }
    deps.config.spellcheck = { enabled: req.enabled, language };
    if (!process.env.TEXERIS_FAUX_PROVIDER) saveWorkspaceConfig(deps.config);
    return { enabled: req.enabled, language };
  });

  ipcMain.handle(SettingsChannels.setPatchStyleMode, (_event, raw: unknown) => {
    const req = Value.Decode(SetPatchStyleModeRequestSchema, raw);
    deps.config.patchStyleMode = req.mode;
    if (!process.env.TEXERIS_FAUX_PROVIDER) saveWorkspaceConfig(deps.config);
    return { mode: req.mode };
  });

  ipcMain.handle(SettingsChannels.disableWritingProfile, () => {
    deps.profiles.disable();
    return { disabled: true };
  });

  ipcMain.handle(SettingsChannels.setApiKey, (_event, raw: unknown) => {
    const req = Value.Decode(SetApiKeyRequestSchema, raw);
    if (!CredentialsService.knownProviders().includes(req.provider)) {
      throw new Error(`unknown provider: ${req.provider}`);
    }
    deps.credentials.setApiKey(req.provider, req.key);
    return { keySource: deps.credentials.keySource(req.provider) };
  });

  ipcMain.handle(SettingsChannels.clearApiKey, (_event, raw: unknown) => {
    const req = Value.Decode(ClearApiKeyRequestSchema, raw);
    deps.credentials.clearApiKey(req.provider);
    return { keySource: deps.credentials.keySource(req.provider) };
  });

  // --------------------------------------------------------------------- ui

  /** Workspace layout state (M1.5 EU1): one validated JSON blob per project. */
  ipcMain.handle(UiChannels.get, () => {
    return new UiStateService(deps.requireProject().db).get();
  });

  ipcMain.handle(UiChannels.set, (_event, raw: unknown) => {
    const state = Value.Decode(UiStateSchema, raw);
    new UiStateService(deps.requireProject().db).set(state);
    return { ok: true };
  });
}
