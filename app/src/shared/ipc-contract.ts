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
import type { DocumentInfo } from './domain-types';

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
    listMessages(conversationId: string): Promise<UiMessage[]>;
    listRuns(conversationId: string): Promise<AgentRunRecord[]>;
    startTurn(request: StartTurnRequest): Promise<{ runId: string }>;
    cancel(runId: string): Promise<{ cancelled: boolean }>;
    /** Subscribe to normalized agent events; returns an unsubscribe fn. */
    onEvent(callback: (event: NormalizedAgentEvent) => void): () => void;
  };
  doc: {
    list(): Promise<DocumentInfo[]>;
    outline(): Promise<HeadingInfo[]>;
    getText(): Promise<DocText>;
    commit(request: DocCommitRequest): Promise<{ seq: number }>;
    restore(revision: number): Promise<{ seq: number }>;
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
}
