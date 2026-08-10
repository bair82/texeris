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
  documentId: Type.Optional(Type.String()),
  splices: Type.Array(TextSpliceSchema, { minItems: 1 }),
  kind: Type.Union([Type.Literal('typing'), Type.Literal('paste')]),
});
export type DocCommitRequest = Static<typeof DocCommitRequestSchema>;

export const DocGetTextRequestSchema = Type.Object({
  documentId: Type.Optional(Type.String()),
});
export type DocGetTextRequest = Static<typeof DocGetTextRequestSchema>;

export const DocOutlineRequestSchema = Type.Object({
  documentId: Type.Optional(Type.String()),
});
export type DocOutlineRequest = Static<typeof DocOutlineRequestSchema>;

export const DocCreateRequestSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
});
export type DocCreateRequest = Static<typeof DocCreateRequestSchema>;

export const DocAddImageRequestSchema = Type.Object({
  documentId: Type.String(),
  sourceName: Type.String({ minLength: 1, maxLength: 255 }),
  mediaType: Type.String({ minLength: 1, maxLength: 64 }),
  dataBase64: Type.String({ minLength: 1, maxLength: 28_000_000 }),
});
export type DocAddImageRequest = Static<typeof DocAddImageRequestSchema>;

export interface AddedImageAsset {
  path: string;
  alt: string;
}

export interface DocumentImportResult {
  id: string;
  path: string;
  title: string;
  warnings: string[];
}

export interface DocumentExportResult {
  path: string;
  format: 'markdown' | 'docx' | 'odt' | 'rtf' | 'pdf';
  warnings: string[];
}

/** Document-management requests (M1.5 EU3) — all id-addressed, never path. */
export const DocRenameRequestSchema = Type.Object({
  documentId: Type.String(),
  name: Type.String({ minLength: 1 }),
});
export type DocRenameRequest = Static<typeof DocRenameRequestSchema>;

export const DocIdRequestSchema = Type.Object({
  documentId: Type.String(),
});
export type DocIdRequest = Static<typeof DocIdRequestSchema>;

export const DocRevisionsRequestSchema = Type.Object({
  documentId: Type.Optional(Type.String()),
});
export type DocRevisionsRequest = Static<typeof DocRevisionsRequestSchema>;

export const CheckpointListRequestSchema = Type.Object({
  documentId: Type.Optional(Type.String()),
});
export type CheckpointListRequest = Static<typeof CheckpointListRequestSchema>;

export const CheckpointCreateRequestSchema = Type.Object({
  documentId: Type.Optional(Type.String()),
  /** Both optional: omitted values are generated (owner request 2026-08-08). */
  name: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
});
export type CheckpointCreateRequest = Static<typeof CheckpointCreateRequestSchema>;

export const CheckpointRenameRequestSchema = Type.Object({
  checkpointId: Type.String(),
  name: Type.Optional(Type.String({ minLength: 1 })),
  description: Type.Optional(Type.String()),
});
export type CheckpointRenameRequest = Static<typeof CheckpointRenameRequestSchema>;

export const CheckpointRestoreRequestSchema = Type.Object({
  checkpointId: Type.String(),
});
export type CheckpointRestoreRequest = Static<typeof CheckpointRestoreRequestSchema>;

export const HistoryChannels = {
  revisions: 'texeris:history-revisions',
  checkpointList: 'texeris:checkpoint-list',
  checkpointCreate: 'texeris:checkpoint-create',
  checkpointRename: 'texeris:checkpoint-rename',
  checkpointRestore: 'texeris:checkpoint-restore',
  /** main → renderer push: a checkpoint's description was (re)generated. */
  event: 'texeris:history-event',
} as const;

export type HistoryEvent = { type: 'checkpoint-updated'; checkpointId: string };

export interface DocText {
  documentId: string;
  path: string;
  text: string;
  revision: number;
}

/** main → renderer push events about external file changes (plan §8). */
export const DocEventSchema = Type.Union([
  Type.Object({
    type: Type.Literal('external-import'),
    documentId: Type.String(),
    revision: Type.Integer({ minimum: 1 }),
  }),
  Type.Object({
    type: Type.Literal('external-conflict'),
    documentId: Type.String(),
  }),
]);
export type DocEvent = Static<typeof DocEventSchema>;

export interface HeadingInfo {
  level: number;
  text: string;
  /** 0-based line number in the canonical text. */
  line: number;
}

/** A trashed document as shown in the trash view (M1.5 EU7). */
export interface TrashedDocumentInfo {
  id: string;
  path: string;
  title: string;
  trashedAt: string;
}

export const DocChannels = {
  list: 'texeris:doc-list',
  outline: 'texeris:doc-outline',
  getText: 'texeris:doc-get-text',
  commit: 'texeris:doc-commit',
  restore: 'texeris:doc-restore',
  create: 'texeris:doc-create',
  rename: 'texeris:doc-rename',
  trash: 'texeris:doc-trash',
  duplicate: 'texeris:doc-duplicate',
  addImage: 'texeris:doc-add-image',
  importDialog: 'texeris:doc-import-dialog',
  exportSettings: 'texeris:doc-export-settings',
  chooseCitationStyle: 'texeris:doc-choose-citation-style',
  exportDialog: 'texeris:doc-export-dialog',
  setMain: 'texeris:doc-set-main',
  reveal: 'texeris:doc-reveal',
  trashList: 'texeris:doc-trash-list',
  restoreTrash: 'texeris:doc-restore-trash',
  deleteTrash: 'texeris:doc-delete-trash',
  event: 'texeris:doc-event',
} as const;
