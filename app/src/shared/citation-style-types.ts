import { Type, type Static } from '@sinclair/typebox';

export const BUILTIN_CITATION_STYLES = [
  { id: 'chicago-author-date', label: 'Chicago author-date' },
  { id: 'apa', label: 'APA 7th edition' },
  { id: 'ieee', label: 'IEEE' },
  { id: 'vancouver', label: 'Vancouver (Elsevier)' },
] as const;

export type BuiltinCitationStyleId = (typeof BUILTIN_CITATION_STYLES)[number]['id'];
export type CitationStyleId = BuiltinCitationStyleId | 'custom';

export interface CitationStyleSettings {
  id: CitationStyleId;
  label: string;
  customAvailable: boolean;
  customLabel?: string;
}

export const CitationStyleIdSchema = Type.Union([
  Type.Literal('chicago-author-date'),
  Type.Literal('apa'),
  Type.Literal('ieee'),
  Type.Literal('vancouver'),
  Type.Literal('custom'),
]);

export const DocExportRequestSchema = Type.Object({
  documentId: Type.String(),
  citationStyle: CitationStyleIdSchema,
});
export type DocExportRequest = Static<typeof DocExportRequestSchema>;
