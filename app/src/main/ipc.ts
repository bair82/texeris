import { app, ipcMain } from 'electron';
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
  StartTurnRequestSchema,
} from '../shared/chat-types';
import { DocChannels, DocCommitRequestSchema } from '../shared/doc-types';
import {
  PatchAcceptRequestSchema,
  PatchChannels,
  PatchGetRequestSchema,
  PatchRejectRequestSchema,
  DocRestoreRequestSchema,
} from '../shared/patch-types';
import {
  ClearApiKeyRequestSchema,
  SetApiKeyRequestSchema,
  SettingsChannels,
  type SettingsView,
} from '../shared/settings-types';
import type { AgentRuntime } from './agent/runtime';
import type { ConversationService } from './services/conversation';
import { CredentialsService } from './services/credentials';
import type { PatchService } from './services/patch';
import type { ProjectContext } from './services/project';
import type { WorkspaceConfig } from './services/settings';
import { extractHeadings } from './agent/markdown';
import { ensureDocument } from './services/project';

export interface IpcDeps {
  runtime: AgentRuntime;
  conversations: ConversationService;
  project: ProjectContext;
  patches: PatchService;
  credentials: CredentialsService;
  config: WorkspaceConfig;
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

  ipcMain.handle(ChatChannels.getOrCreateConversation, () => ({
    conversationId: deps.conversations.getOrCreateConversation(),
  }));

  ipcMain.handle(ChatChannels.listMessages, (_event, raw: unknown) => {
    const req = Value.Decode(ConversationRequestSchema, raw);
    return deps.conversations.listUiMessages(req.conversationId);
  });

  ipcMain.handle(ChatChannels.listRuns, (_event, raw: unknown) => {
    const req = Value.Decode(ConversationRequestSchema, raw);
    return deps.conversations.listRuns(req.conversationId);
  });

  ipcMain.handle(ChatChannels.startTurn, async (event, raw: unknown) => {
    const req = Value.Decode(StartTurnRequestSchema, raw);
    const { runId } = await deps.runtime.startTurn(req);
    // Forward this run's events to the requesting window until the queue
    // closes (run end). Events originate in main — trusted, not re-validated.
    void (async () => {
      for await (const agentEvent of deps.runtime.events(runId)) {
        if (!event.sender.isDestroyed()) {
          event.sender.send(ChatChannels.event, agentEvent);
        }
      }
    })();
    return { runId };
  });

  ipcMain.handle(ChatChannels.cancel, async (_event, raw: unknown) => {
    const req = Value.Decode(CancelRequestSchema, raw);
    await deps.runtime.cancel(req.runId);
    return { cancelled: true };
  });

  ipcMain.handle(DocChannels.list, () => {
    const rows = deps.project.db
      .prepare(
        'SELECT id, path, title, current_revision, content_hash FROM documents ORDER BY path',
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

  ipcMain.handle(DocChannels.outline, () => {
    const docId = ensureDocument(deps.project, deps.project.project.mainDocument);
    const text = deps.project.revisions.getCurrentText(docId);
    return extractHeadings(text);
  });

  ipcMain.handle(DocChannels.getText, () => {
    const docId = ensureDocument(deps.project, deps.project.project.mainDocument);
    return {
      documentId: docId,
      path: deps.project.project.mainDocument,
      text: deps.project.revisions.getCurrentText(docId),
      revision: deps.project.revisions.getCurrentRevision(docId),
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
    const docId = ensureDocument(deps.project, deps.project.project.mainDocument);
    const seq = deps.project.revisions.commit(docId, req.splices, {
      actor: 'user',
      source: { kind: req.kind },
    });
    return { seq };
  });

  /** Restore an earlier revision as a new revision (undo path, §8). */
  ipcMain.handle(DocChannels.restore, (_event, raw: unknown) => {
    const req = Value.Decode(DocRestoreRequestSchema, raw);
    const docId = ensureDocument(deps.project, deps.project.project.mainDocument);
    const seq = deps.project.revisions.restore(docId, req.revision);
    return { seq };
  });

  ipcMain.handle(PatchChannels.list, () => {
    const docId = ensureDocument(deps.project, deps.project.project.mainDocument);
    return deps.patches.list(docId);
  });

  ipcMain.handle(PatchChannels.get, (_event, raw: unknown) => {
    const req = Value.Decode(PatchGetRequestSchema, raw);
    const patch = deps.patches.get(req.patchId);
    if (!patch) {
      throw new Error(`unknown patch: ${req.patchId}`);
    }
    return patch;
  });

  ipcMain.handle(PatchChannels.accept, (_event, raw: unknown) => {
    const req = Value.Decode(PatchAcceptRequestSchema, raw);
    return deps.patches.accept(req.patchId, req.groupIds);
  });

  ipcMain.handle(PatchChannels.reject, (_event, raw: unknown) => {
    const req = Value.Decode(PatchRejectRequestSchema, raw);
    deps.patches.reject(req.patchId, req.groupIds);
    return { rejected: true };
  });

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
}
