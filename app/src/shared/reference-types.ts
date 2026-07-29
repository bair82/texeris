import { Type, type Static } from '@sinclair/typebox';

export interface CslName {
  family?: string;
  given?: string;
  literal?: string;
  [key: string]: unknown;
}

export interface CslReference {
  id: string;
  type?: string;
  title?: string;
  author?: CslName[];
  issued?: { 'date-parts'?: Array<Array<number | string>> };
  DOI?: string;
  URL?: string;
  [key: string]: unknown;
}

export interface ReferenceListItem {
  key: string;
  title: string;
  authors: string;
  year: string;
  type: string;
}

export interface ReferenceImportReport {
  imported: number;
  skipped: number;
  renamed: Array<{ from: string; to: string }>;
  warnings: string[];
  total: number;
  sourceName: string;
}

export interface CitationAudit {
  citedKeys: string[];
  unresolvedKeys: string[];
  unusedKeys: string[];
}

export const ReferenceSearchRequestSchema = Type.Object({
  query: Type.String({ maxLength: 500 }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

export const ReferenceAuditRequestSchema = Type.Object({
  markdown: Type.String({ maxLength: 20_000_000 }),
});

export const ReferenceChannels = {
  list: 'texeris:references-list',
  search: 'texeris:references-search',
  importDialog: 'texeris:references-import-dialog',
  audit: 'texeris:references-audit',
} as const;

export type ReferenceSearchRequest = Static<typeof ReferenceSearchRequestSchema>;
