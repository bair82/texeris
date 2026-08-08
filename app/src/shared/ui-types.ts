import { Type, type Static } from '@sinclair/typebox';

/**
 * UI-state IPC contract (M1.5 EU1): per-project workspace layout state,
 * stored as one JSON blob in the project DB's `settings` table. All fields
 * are optional so older/newer app versions tolerate each other's payloads;
 * the renderer merges over its own defaults.
 */

export const UiStateDocSchema = Type.Object({
  /** Canonical-text caret offset (approximate in rendered mode). */
  cursor: Type.Optional(Type.Number({ minimum: 0 })),
  /** 0..1 position within the scrollable range. */
  scrollFraction: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});
export type UiStateDoc = Static<typeof UiStateDocSchema>;

export const UiStateSchema = Type.Object({
  navWidth: Type.Optional(Type.Number()),
  sideWidth: Type.Optional(Type.Number()),
  navVisible: Type.Optional(Type.Boolean()),
  navMode: Type.Optional(
    Type.Union([Type.Literal('files'), Type.Literal('archive')]),
  ),
  sideVisible: Type.Optional(Type.Boolean()),
  focusMode: Type.Optional(Type.Boolean()),
  editorMode: Type.Optional(
    Type.Union([Type.Literal('rendered'), Type.Literal('raw')]),
  ),
  openDocumentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  openConversationId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  /** Per-document view state, keyed by document id. */
  documents: Type.Optional(Type.Record(Type.String(), UiStateDocSchema)),
});
export type UiState = Static<typeof UiStateSchema>;

export const UiChannels = {
  get: 'texeris:ui-get',
  set: 'texeris:ui-set',
} as const;
