import { Type, type Static } from '@sinclair/typebox';

export const ProfileArtifactKindSchema = Type.Union([
  Type.Literal('writing-style-report'),
  Type.Literal('writing-profile'),
  Type.Literal('intellectual-profile'),
]);
export type ProfileArtifactKind = Static<typeof ProfileArtifactKindSchema>;

export const ProfileArtifactRefSchema = Type.Object({
  kind: ProfileArtifactKindSchema,
  documentId: Type.String(),
  path: Type.String(),
  revision: Type.Integer({ minimum: 0 }),
});
export type ProfileArtifactRef = Static<typeof ProfileArtifactRefSchema>;

export const ActiveWritingProfileSchema = Type.Object({
  id: Type.String(),
  activatedAt: Type.String(),
  sourceProject: Type.String(),
  artifacts: Type.Array(ProfileArtifactRefSchema, { minItems: 3, maxItems: 3 }),
});
export type ActiveWritingProfile = Static<typeof ActiveWritingProfileSchema>;

export interface CorpusSourceView {
  id: string;
  originalPath: string;
  format: string;
  size: number;
  modifiedAt: string;
  detectedDate: string | null;
  dateConfidence: string | null;
  warnings: string[];
}

export const ProfileBeginRequestSchema = Type.Object({
  source: Type.Union([Type.Literal('files'), Type.Literal('folder')]),
});
export type ProfileBeginRequest = Static<typeof ProfileBeginRequestSchema>;

export const ProfileActivateRequestSchema = Type.Object({
  reportDocumentId: Type.String(),
  writingProfileDocumentId: Type.String(),
  intellectualProfileDocumentId: Type.String(),
});
export type ProfileActivateRequest = Static<typeof ProfileActivateRequestSchema>;

export const ProfileChannels = {
  begin: 'texeris:profile-begin',
  active: 'texeris:profile-active',
} as const;

/** Per-grant summary for the settings corpus section. */
export interface CorpusGrantView {
  grantId: string;
  conversationId: string;
  conversationTitle: string;
  createdAt: string;
  sourceCount: number;
  totalBytes: number;
}

export const CorpusDeleteRequestSchema = Type.Object({
  grantId: Type.String(),
});
export type CorpusDeleteRequest = Static<typeof CorpusDeleteRequestSchema>;

export const CorpusChannels = {
  list: 'texeris:corpus-list',
  delete: 'texeris:corpus-delete',
} as const;
