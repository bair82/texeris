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

export const REFERENCE_KINDS = [
  'article-journal',
  'book',
  'chapter',
  'paper-conference',
  'thesis',
  'report',
  'webpage',
  'document',
] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

export interface ReferenceDraft {
  citationKey: string;
  type: ReferenceKind;
  title: string;
  authors: string;
  year: string;
  doi: string;
  url: string;
}

export interface ReferenceCreateResult {
  item: ReferenceListItem;
  created: boolean;
  warnings: string[];
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

export const ReferenceDraftSchema = Type.Object(
  {
    citationKey: Type.String({ maxLength: 200 }),
    type: Type.Union([
      Type.Literal('article-journal'),
      Type.Literal('book'),
      Type.Literal('chapter'),
      Type.Literal('paper-conference'),
      Type.Literal('thesis'),
      Type.Literal('report'),
      Type.Literal('webpage'),
      Type.Literal('document'),
    ]),
    title: Type.String({ maxLength: 10_000 }),
    authors: Type.String({ maxLength: 10_000 }),
    year: Type.String({ maxLength: 20 }),
    doi: Type.String({ maxLength: 2_000 }),
    url: Type.String({ maxLength: 10_000 }),
  },
  { additionalProperties: false },
);

export const ReferenceDoiLookupRequestSchema = Type.Object(
  {
    doi: Type.String({ minLength: 1, maxLength: 2_000 }),
  },
  { additionalProperties: false },
);

export const ReferenceChannels = {
  list: 'texeris:references-list',
  search: 'texeris:references-search',
  importDialog: 'texeris:references-import-dialog',
  lookupDoi: 'texeris:references-lookup-doi',
  create: 'texeris:references-create',
  audit: 'texeris:references-audit',
} as const;

export type ReferenceSearchRequest = Static<typeof ReferenceSearchRequestSchema>;
export type ReferenceDraftRequest = Static<typeof ReferenceDraftSchema>;
