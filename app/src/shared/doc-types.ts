import { Type, type Static } from '@sinclair/typebox';

/**
 * Document-editing IPC contract (WP2): the renderer editor commits grouped
 * text changes; main validates, applies them to the canonical file, and
 * records revisions (plan §8 commit flow).
 */

export const TextSpliceSchema = Type.Object({
  from: Type.Integer({ minimum: 0 }),
  to: Type.Integer({ minimum: 0 }),
  deletedText: Type.String(),
  insertedText: Type.String(),
});

export const DocCommitRequestSchema = Type.Object({
  splices: Type.Array(TextSpliceSchema, { minItems: 1 }),
  kind: Type.Union([Type.Literal('typing'), Type.Literal('paste')]),
});
export type DocCommitRequest = Static<typeof DocCommitRequestSchema>;

export interface DocText {
  documentId: string;
  path: string;
  text: string;
  revision: number;
}

/** main → renderer push events about external file changes (plan §8). */
export type DocEvent =
  | { type: 'external-import'; revision: number }
  | { type: 'external-conflict' };

export interface HeadingInfo {
  level: number;
  text: string;
  /** 0-based line number in the canonical text. */
  line: number;
}

export const DocChannels = {
  list: 'texeris:doc-list',
  outline: 'texeris:doc-outline',
  getText: 'texeris:doc-get-text',
  commit: 'texeris:doc-commit',
  restore: 'texeris:doc-restore',
  event: 'texeris:doc-event',
} as const;
