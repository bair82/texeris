import { Type, type Static } from '@sinclair/typebox';
import type {
  AgentRunRecord,
  NormalizedAgentEvent,
  StartTurnRequest,
  UiMessage,
} from './chat-types';
import type {
  DocCommitRequest,
  DocEvent,
  DocText,
  HeadingInfo,
} from './doc-types';
import type {
  PatchConflictItem,
  PatchProposedEvent,
  PatchRecord,
} from './patch-types';
import type { SettingsView } from './settings-types';
import type { CheckpointInfo, DocumentInfo, RevisionInfo } from './domain-types';
import type { ProjectInfo } from './project-types';

/**
 * IPC contract shared by main, preload, and renderer.
 * Every payload that crosses the contextBridge is validated against a
 * TypeBox schema on both sides; a malformed payload fails loudly.
 */

export const IpcChannels = {
  getAppInfo: 'texeris:get-app-info',
} as const;

export const AppInfoSchema = Type.Object({
  appVersion: Type.String(),
  platform: Type.String(),
  arch: Type.String(),
  electronVersion: Type.String(),
  nodeVersion: Type.String(),
});
export type AppInfo = Static<typeof AppInfoSchema>;

/** The narrow API the preload bridge exposes as `window.texeris`. */
export interface TexerisApi {
  getAppInfo(): Promise<AppInfo>;
  chat: {
    getOrCreateConversation(): Promise<{ conversationId: string }>;
    newConversation(): Promise<{ conversationId: string }>;
    listMessages(conversationId: string): Promise<UiMessage[]>;
    listRuns(conversationId: string): Promise<AgentRunRecord[]>;
    startTurn(request: StartTurnRequest): Promise<{ runId: string }>;
    cancel(runId: string): Promise<{ cancelled: boolean }>;
    /** Subscribe to normalized agent events; returns an unsubscribe fn. */
    onEvent(callback: (event: NormalizedAgentEvent) => void): () => void;
  };
  doc: {
    list(): Promise<DocumentInfo[]>;
    outline(documentId?: string): Promise<HeadingInfo[]>;
    getText(documentId?: string): Promise<DocText>;
    commit(request: DocCommitRequest): Promise<{ seq: number }>;
    restore(revision: number, documentId?: string): Promise<{ seq: number }>;
    create(name: string): Promise<{ id: string; path: string; title: string }>;
    onEvent(callback: (event: DocEvent) => void): () => void;
  };
  patch: {
    list(): Promise<PatchRecord[]>;
    get(patchId: string): Promise<PatchRecord>;
    accept(
      patchId: string,
      groupIds?: string[],
    ): Promise<{ seq: number; previousSeq: number } | { conflict: PatchConflictItem[] }>;
    reject(patchId: string, groupIds?: string[]): Promise<{ rejected: boolean }>;
    onEvent(callback: (event: PatchProposedEvent) => void): () => void;
  };
  settings: {
    get(): Promise<SettingsView>;
    setApiKey(provider: string, key: string): Promise<{ keySource: string }>;
    clearApiKey(provider: string): Promise<{ keySource: string }>;
  };
  project: {
    current(): Promise<ProjectInfo | null>;
    recents(): Promise<string[]>;
    pickDirectory(): Promise<string | null>;
    openDialog(): Promise<ProjectInfo | null>;
    openPath(path: string): Promise<ProjectInfo>;
    create(parentDir: string, name: string): Promise<ProjectInfo>;
    onChanged(callback: (info: ProjectInfo) => void): () => void;
  };
  history: {
    revisions(documentId?: string): Promise<RevisionInfo[]>;
    listCheckpoints(documentId?: string): Promise<CheckpointInfo[]>;
    createCheckpoint(name: string, documentId?: string): Promise<CheckpointInfo>;
    restoreCheckpoint(checkpointId: string): Promise<{ seq: number }>;
  };
}
