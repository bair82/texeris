/**
 * Domain types shared by main and renderer (documents, revisions, patches,
 * conversations). WP1 lands the storage-core types; patch/conversation types
 * arrive with WP3/WP4.
 */

/**
 * A single atomic text splice. Offsets are UTF-16 code-unit indices (plain
 * JS string indices). Splices are applied sequentially: each splice's
 * offsets refer to the text produced by the splices before it, and
 * `deletedText` must match the text at [from, to) at that point.
 */
export interface TextSplice {
  from: number;
  to: number;
  deletedText: string;
  insertedText: string;
}

/** Who produced a revision. */
export type Actor = 'user' | 'agent' | 'external' | 'system';

/** Audit link from a revision to whatever caused it (plan §7.3). */
export interface RevisionSource {
  kind: 'typing' | 'paste' | 'patch' | 'restore' | 'checkpoint' | 'external' | 'import' | 'report';
  conversationId?: string;
  agentRunId?: string;
  patchId?: string;
  /** For restores: the revision whose content was restored. */
  fromRevision?: number;
}

export interface DocumentInfo {
  id: string;
  /** Path relative to the project root. */
  path: string;
  title: string;
  currentRevision: number;
  contentHash: string;
}

export interface RevisionInfo {
  documentId: string;
  seq: number;
  parentSeq: number | null;
  actor: Actor;
  source: RevisionSource;
  summary: string;
  contentHash: string;
  createdAt: string;
}

export interface CheckpointInfo {
  id: string;
  documentId: string;
  revisionSeq: number;
  name: string;
  createdAt: string;
}
