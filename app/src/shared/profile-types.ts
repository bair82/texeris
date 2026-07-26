import { Type, type Static } from '@sinclair/typebox';

export type ProfileArtifactKind =
  | 'writing-style-report'
  | 'writing-profile'
  | 'intellectual-profile';

export interface ProfileArtifactRef {
  kind: ProfileArtifactKind;
  documentId: string;
  path: string;
  revision: number;
}

export interface ActiveWritingProfile {
  id: string;
  activatedAt: string;
  sourceProject: string;
  artifacts: ProfileArtifactRef[];
}

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
