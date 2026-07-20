/**
 * Module-level bridges between the editor region and other panes:
 * - selection getter (chat's selection scope)
 * - highlight handler (patch review shows affected ranges in the editor)
 * - reload handler (patch application/undo changed the canonical text)
 * Kept framework-free on purpose.
 */

export function registerSelectionGetter(
  getter: () => { from: number; to: number } | null,
): () => void {
  selectionGetter = getter;
  return () => {
    if (selectionGetter === getter) {
      selectionGetter = null;
    }
  };
}

let selectionGetter: (() => { from: number; to: number } | null) | null = null;

export function getEditorSelection(): { from: number; to: number } | null {
  return selectionGetter?.() ?? null;
}

export interface HighlightRange {
  from: number;
  to: number;
  /** Expected/inserted text at the range — used to locate it approximately. */
  snippet: string;
}

let highlightHandler: ((ranges: HighlightRange[]) => void) | null = null;

export function registerHighlightHandler(handler: (ranges: HighlightRange[]) => void): () => void {
  highlightHandler = handler;
  return () => {
    if (highlightHandler === handler) {
      highlightHandler = null;
    }
  };
}

export function highlightInEditor(ranges: HighlightRange[]): void {
  highlightHandler?.(ranges);
}

let reloadHandler: (() => void) | null = null;

export function registerReloadHandler(handler: () => void): () => void {
  reloadHandler = handler;
  return () => {
    if (reloadHandler === handler) {
      reloadHandler = null;
    }
  };
}

export function reloadEditor(): void {
  reloadHandler?.();
}

/** Outline navigation (EU2): ProjectNav asks the editor to jump to a heading. */
let navigateHandler: ((headingText: string) => void) | null = null;

export function registerNavigateHandler(
  handler: (headingText: string) => void,
): () => void {
  navigateHandler = handler;
  return () => {
    if (navigateHandler === handler) {
      navigateHandler = null;
    }
  };
}

export function navigateToHeading(headingText: string): void {
  navigateHandler?.(headingText);
}
