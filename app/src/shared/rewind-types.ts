import { Type, type Static } from '@sinclair/typebox';

/**
 * Conversation/document rewind IPC contract (G1 §8): the user picks an
 * earlier completed turn or checkpoint, previews the boundary, then rewinds —
 * the document is restored as a NEW revision (append-only) and turn points
 * also fork the conversation from the message boundary. Every point carries
 * a short human-readable description for the picker.
 */

export type RewindPointKind = 'turn' | 'checkpoint';

export interface RewindPoint {
  kind: RewindPointKind;
  /** runId for turns, checkpointId for checkpoints. */
  id: string;
  /** Short human-readable description shown in the rewind picker. */
  description: string;
  createdAt: string;
  /** Document this point restores. */
  documentId: string;
  /** Document revision this point restores (null = conversation-only turn). */
  targetRevision: number | null;
  /** Last conversation message seq of the turn (turns only). */
  boundarySeq?: number;
}

export interface RewindPendingPatch {
  id: string;
  title: string;
  status: string;
}

export interface RewindPreview {
  point: RewindPoint;
  currentRevision: number;
  currentText: string;
  targetText: string;
  /** Unresolved patches kept after the rewind; stale ones degrade to
   * 'conflict' at accept time — surfaced here so nothing is silently lost. */
  pendingPatches: RewindPendingPatch[];
}

export interface RewindResult {
  documentId: string;
  /** New revision produced by the restore (or the current one if identical). */
  revisionSeq: number;
  /** Forked conversation id (turn points only). */
  conversationId?: string;
}

export const RewindListRequestSchema = Type.Object({
  conversationId: Type.String(),
  documentId: Type.Optional(Type.String()),
});
export type RewindListRequest = Static<typeof RewindListRequestSchema>;

export const RewindPreviewRequestSchema = Type.Object({
  conversationId: Type.String(),
  kind: Type.Union([Type.Literal('turn'), Type.Literal('checkpoint')]),
  id: Type.String({ minLength: 1 }),
});
export type RewindPreviewRequest = Static<typeof RewindPreviewRequestSchema>;

export const RewindApplyRequestSchema = Type.Object({
  conversationId: Type.String(),
  kind: Type.Union([Type.Literal('turn'), Type.Literal('checkpoint')]),
  id: Type.String({ minLength: 1 }),
});
export type RewindApplyRequest = Static<typeof RewindApplyRequestSchema>;

export const RewindChannels = {
  list: 'texeris:rewind-list',
  preview: 'texeris:rewind-preview',
  apply: 'texeris:rewind-apply',
} as const;
