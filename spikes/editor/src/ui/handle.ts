/** Shared contract between the two editor tabs and the UI shell. */

import type { ApplyResult, DocumentPatch } from '../lib/patch';
import type { RevisionEventInput } from '../lib/revisions';

export type EditorMode = 'rendered' | 'raw';

export interface EditorHandle {
  readonly kind: 'codemirror' | 'tiptap';
  mount(parent: HTMLElement): void;
  destroy(): void;
  /** Canonical Markdown text as currently held by this editor. */
  getCanonicalText(): string;
  /** Replace content (sample switch). Never produces a revision. */
  setCanonicalText(text: string): void;
  setMode(mode: EditorMode): void;
  getMode(): EditorMode;
  /** Apply a structured patch to the canonical text. */
  applyDocumentPatch(patch: DocumentPatch, groupIds?: string[]): ApplyResult;
  /** Edit the text through the editor as a *user* edit (conflict demo). */
  replaceLiteral(find: string, insert: string): boolean;
  onRevisionEvent(cb: (ev: RevisionEventInput) => void): void;
  focus(): void;
}
