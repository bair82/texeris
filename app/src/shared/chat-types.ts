import { Type, type Static } from '@sinclair/typebox';

/**
 * Chat/agent domain + IPC types shared by main, preload, and renderer.
 * Request payloads (renderer → main) are validated in main against these
 * schemas. Streaming chat events originate in trusted main code and carry
 * display content only; any later renderer request is validated again by
 * main.
 */

export type ModelMode = 'fast' | 'deep';

/** What the agent sees. `selection` is a seam wired in WP2 (editor). */
export type ContextScope =
  | { kind: 'document'; documentId?: string }
  | { kind: 'section'; heading: string; documentId?: string }
  | { kind: 'selection'; from: number; to: number; documentId?: string };

export const ContextScopeSchema = Type.Union([
  Type.Object({ kind: Type.Literal('document'), documentId: Type.Optional(Type.String()) }),
  Type.Object({ kind: Type.Literal('section'), heading: Type.String(), documentId: Type.Optional(Type.String()) }),
  Type.Object({
    kind: Type.Literal('selection'),
    from: Type.Integer({ minimum: 0 }),
    to: Type.Integer({ minimum: 0 }),
    documentId: Type.Optional(Type.String()),
  }),
]);

export const ContextManifestItemSchema = Type.Object({
  label: Type.String(),
  chars: Type.Integer({ minimum: 0 }),
});
export type ContextManifestItem = Static<typeof ContextManifestItemSchema>;

/** What actually went into the model's context for a run (plan §11). */
export const ContextManifestSchema = Type.Object({
  scope: ContextScopeSchema,
  documentId: Type.String(),
  items: Type.Array(ContextManifestItemSchema),
  baseRevision: Type.Integer({ minimum: 0 }),
  /**
   * Number of change rows the base revision had when this context was
   * assembled. Revision coalescing appends user typing to the tip revision,
   * so "what changed since the run" is tracked by change index, not only by
   * revision number. Absent in manifests predating coalescing.
   */
  baseChangeCount: Type.Optional(Type.Integer({ minimum: 0 })),
  truncated: Type.Boolean(),
  notices: Type.Array(Type.String()),
  archivePassageIds: Type.Optional(Type.Array(Type.String(), { maxItems: 12 })),
});
export type ContextManifest = Static<typeof ContextManifestSchema>;

/** Self-contained boundary stored with a persisted user message. */
export const TurnContextSchema = Type.Object({
  runId: Type.String(),
  mode: Type.Union([Type.Literal('fast'), Type.Literal('deep')]),
  manifest: ContextManifestSchema,
});
export type TurnContext = Static<typeof TurnContextSchema>;

export interface UsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
}

/** Normalized agent events pushed to the renderer (architecture §12.3). */
export type NormalizedAgentEvent =
  | { type: 'run_start'; runId: string; mode: ModelMode }
  | { type: 'text_delta'; runId: string; delta: string }
  | { type: 'thinking_delta'; runId: string; delta: string }
  | { type: 'tool_start'; runId: string; toolCallId: string; toolName: string }
  | {
      type: 'tool_end';
      runId: string;
      toolCallId: string;
      toolName: string;
      isError: boolean;
    }
  | {
      type: 'run_end';
      runId: string;
      status: 'completed' | 'aborted' | 'error';
      errorMessage?: string;
      usage?: UsageSummary;
      manifest: ContextManifest;
    }
  | {
      type: 'delegation_start' | 'delegation_end';
      runId: string;
      delegationId: string;
      role: string;
      status: 'running' | 'completed' | 'error' | 'aborted';
      summary: string;
    }
  | {
      type: 'profile_artifacts_created';
      runId: string;
      reportDocumentId: string;
      writingProfileDocumentId: string;
      intellectualProfileDocumentId: string;
    };

export type RunStatus = 'running' | 'completed' | 'aborted' | 'error';

export interface AgentRunRecord {
  id: string;
  conversationId: string;
  modelMode: ModelMode;
  provider: string;
  model: string;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  usage: UsageSummary | null;
  manifest: ContextManifest | null;
  error: string | null;
  parentRunId?: string | null;
  roleId?: string | null;
  skillId?: string | null;
  skillVersion?: number | null;
}

/** Renderer-facing conversation message (derived from stored AgentMessages). */
export interface UiMessage {
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  toolName?: string;
  isError?: boolean;
}

export interface EditMessagePreview {
  conversationId: string;
  messageSeq: number;
  text: string;
  mode: ModelMode;
  scope: ContextScope;
  documentId: string;
  documentPath: string;
  targetRevision: number;
  targetChangeCount: number;
  currentRevision: number;
  boundaryExact: boolean;
  documentChanged: boolean;
  laterMessageCount: number;
  pendingPatchCount: number;
  currentText: string;
  targetText: string;
  archivePassageIds?: string[];
}

export interface ForkMessageResult {
  originalConversationId: string;
  conversationId: string;
  documentId: string;
  restoredRevision: number;
  mode: ModelMode;
  scope: ContextScope;
  archivePassageIds?: string[];
}

export const StartTurnRequestSchema = Type.Object({
  conversationId: Type.String(),
  text: Type.String({ minLength: 1 }),
  mode: Type.Union([Type.Literal('fast'), Type.Literal('deep')]),
  scope: ContextScopeSchema,
  archivePassageIds: Type.Optional(Type.Array(Type.String(), { maxItems: 12 })),
});
export type StartTurnRequest = Static<typeof StartTurnRequestSchema>;

export const CancelRequestSchema = Type.Object({ runId: Type.String() });
export type CancelRequest = Static<typeof CancelRequestSchema>;

export const ConversationRequestSchema = Type.Object({
  conversationId: Type.String(),
});
export type ConversationRequest = Static<typeof ConversationRequestSchema>;

export const EditMessageRequestSchema = Type.Object({
  conversationId: Type.String(),
  messageSeq: Type.Integer({ minimum: 1 }),
  reason: Type.Optional(
    Type.Union([Type.Literal('edit'), Type.Literal('regenerate')]),
  ),
});
export type EditMessageRequest = Static<typeof EditMessageRequestSchema>;

export const ChatChannels = {
  getOrCreateConversation: 'texeris:chat-get-or-create-conversation',
  newConversation: 'texeris:chat-new-conversation',
  listConversations: 'texeris:chat-list-conversations',
  renameConversation: 'texeris:chat-rename-conversation',
  deleteConversation: 'texeris:chat-delete-conversation',
  listMessages: 'texeris:chat-list-messages',
  listRuns: 'texeris:chat-list-runs',
  listDelegations: 'texeris:chat-list-delegations',
  previewMessageEdit: 'texeris:chat-preview-message-edit',
  forkMessage: 'texeris:chat-fork-message',
  startTurn: 'texeris:chat-start-turn',
  cancel: 'texeris:chat-cancel',
  /** main → renderer push channel for NormalizedAgentEvent */
  event: 'texeris:chat-event',
} as const;

/** One row of the conversation picker (M1.5 EU3). */
export interface ConversationListItem {
  id: string;
  title: string;
  createdAt: string;
  messageCount: number;
}

export interface DelegationRecord {
  id: string;
  parentRunId: string;
  role: string;
  status: 'running' | 'completed' | 'error' | 'aborted';
  task: string;
  summary: string | null;
  provider: string;
  model: string;
  createdAt: string;
  endedAt: string | null;
}

export const RenameConversationRequestSchema = Type.Object({
  conversationId: Type.String(),
  title: Type.String({ minLength: 1 }),
});
export type RenameConversationRequest = Static<typeof RenameConversationRequestSchema>;
