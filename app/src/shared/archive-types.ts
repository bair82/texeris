import { Type, type Static } from '@sinclair/typebox';

export interface ArchiveSourceView {
  id: string;
  title: string;
  originalPath: string;
  format: string;
  size: number;
  modifiedAt: string;
  importedAt: string;
  status: 'current' | 'changed' | 'missing';
  passageCount: number;
  warnings: string[];
}

export interface ArchiveSearchResult {
  passageId: string;
  sourceId: string;
  title: string;
  heading: string | null;
  page: number | null;
  excerpt: string;
  startOffset: number;
}

export interface ArchiveAttachment extends ArchiveSearchResult {}

export interface ArchivePreview {
  source: ArchiveSourceView;
  text: string;
  offset: number;
  totalChars: number;
  truncated: boolean;
}

export interface ArchiveImportReport {
  imported: number;
  duplicates: number;
  skipped: number;
  warnings: string[];
}

export interface ArchiveReindexReport {
  sources: number;
  passages: number;
}

export const ArchiveImportRequestSchema = Type.Object({
  source: Type.Union([Type.Literal('files'), Type.Literal('folder')]),
});
export type ArchiveImportRequest = Static<typeof ArchiveImportRequestSchema>;

export const ArchiveSearchRequestSchema = Type.Object({
  query: Type.String({ maxLength: 500 }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

export const ArchiveSourceRequestSchema = Type.Object({
  sourceId: Type.String(),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
});

export const ArchivePassagesRequestSchema = Type.Object({
  passageIds: Type.Array(Type.String(), { maxItems: 12 }),
});

export const ArchiveProfileRequestSchema = Type.Object({
  sourceIds: Type.Array(Type.String(), { minItems: 1, maxItems: 200 }),
});

export const ArchiveChannels = {
  list: 'texeris:archive-list',
  importDialog: 'texeris:archive-import-dialog',
  search: 'texeris:archive-search',
  preview: 'texeris:archive-preview',
  passages: 'texeris:archive-passages',
  delete: 'texeris:archive-delete',
  reindex: 'texeris:archive-reindex',
  buildProfile: 'texeris:archive-build-profile',
} as const;
