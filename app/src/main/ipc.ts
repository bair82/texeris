import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
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
  SettingsChannels,
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
import { extractHeadings } from './agent/markdown';
import {
  duplicateDocument,
  importDocumentFile,
  renameDocument,
  setMainDocument,
  trashDocument,
} from './services/documents';
import { createDocument, ensureDocument } from './services/project';

export interface IpcDeps {
  requireProject(): ProjectContext;
  requireRuntime(): AgentRuntime;
  requireConversations(): ConversationService;
  requirePatches(): PatchService;
  credentials: CredentialsService;
  config: WorkspaceConfig;
  manager: ProjectManager;
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
      title: 'Import a Markdown file',
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'txt'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return importDocumentFile(deps.requireProject(), result.filePaths[0]);
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

  ipcMain.handle(PatchChannels.list, () => {
    const project = deps.requireProject();
    const docId = ensureDocument(project, project.project.mainDocument);
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
    };
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
