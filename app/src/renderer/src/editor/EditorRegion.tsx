import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import type { UiStateDoc } from '../../../shared/ui-types';
import type { EditorMode, EditorSession } from './session';
import { RawSession, RenderedSession } from './session';
import {
  registerEditorCommands,
  registerHighlightHandler,
  registerNavigateHandler,
  registerReloadHandler,
  registerSelectionGetter,
} from './editorBridge';
import HistoryPanel from './HistoryPanel';
import SearchPanel from './SearchPanel';
import Toolbar from './Toolbar';
import CitationPicker from './CitationPicker';

type SaveState = 'loading' | 'saved' | 'dirty' | 'saving' | 'error';

/** Word count that ignores Markdown syntax tokens (headings, pipes, rules). */
function countWords(text: string): number {
  const tokens = text.match(/\S+/g) ?? [];
  let count = 0;
  for (const token of tokens) {
    if (/[\p{L}\p{N}]/u.test(token)) {
      count += 1;
    }
  }
  return count;
}

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('could not read image'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      if (comma < 0) reject(new Error('could not encode image'));
      else resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

function imageMediaType(file: File): string {
  if (file.type) return file.type;
  const extension = file.name.split('.').pop()?.toLowerCase();
  const types: Record<string, string> = {
    avif: 'image/avif',
    gif: 'image/gif',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
  };
  return types[extension ?? ''] ?? '';
}

interface EditorNotice {
  text: string;
  actionLabel?: string;
  onAction?: () => void;
}

export interface WorkspaceStatus {
  message: string;
  tone: 'progress' | 'success' | 'warning' | 'error';
  /** Offered on progress notices for cancellable background jobs. */
  onCancel?: () => void;
}

interface EditorRegionProps {
  /** The document to show; the region (re)opens whenever this changes. */
  openDocId: string | null;
  /** Per-document view state (cursor/scroll) restored when opening a doc. */
  docStates: Record<string, UiStateDoc>;
  /** Mode at mount; afterwards the region owns it and reports changes. */
  initialMode: EditorMode;
  /** Report cursor/scroll for a document (debounced IPC persistence). */
  onDocState(docId: string, patch: UiStateDoc): void;
  onModeChange(mode: EditorMode): void;
  /** Report the committed revision (drives the nav outline refresh). */
  onRevisionChange(revision: number): void;
  /** Workspace-wide operation feedback temporarily replaces the word count. */
  workspaceStatus?: WorkspaceStatus | null;
  onDismissWorkspaceStatus?(): void;
}

/**
 * The editor region (plan §12): rendered mode default with a raw toggle,
 * commit-on-group over IPC (autosave), external-change reload, find &
 * replace (EU2), and a status bar with revision + save state. Document
 * selection lives in the shell (M1.5 EU1); this region opens whatever
 * document it is handed and reports view state (cursor, scroll) back for
 * persistence.
 */
export default function EditorRegion({
  openDocId,
  docStates,
  initialMode,
  onDocState,
  onModeChange,
  onRevisionChange,
  workspaceStatus,
  onDismissWorkspaceStatus,
}: EditorRegionProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<EditorSession | null>(null);
  const [mode, setMode] = useState<EditorMode>(initialMode);
  const [revision, setRevision] = useState<number | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('loading');
  const [notice, setNotice] = useState<EditorNotice | null>(null);
  const [activeEditor, setActiveEditor] = useState<Editor | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [citationPicker, setCitationPicker] = useState<
    { mode: 'insert' } | { mode: 'replace'; position: number } | null
  >(null);
  const [wordCount, setWordCount] = useState<number | null>(null);
  const [selStats, setSelStats] = useState<{ words: number; chars: number } | null>(null);
  const lastCountedTextRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const loadedDocIdRef = useRef<string | null>(null);
  const openSeqRef = useRef(0);
  const scrollCleanupRef = useRef<(() => void) | null>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCommitsRef = useRef(new Set<Promise<void>>());
  const commitErrorsRef = useRef<unknown[]>([]);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const docStatesRef = useRef(docStates);
  docStatesRef.current = docStates;
  const onDocStateRef = useRef(onDocState);
  onDocStateRef.current = onDocState;
  const onRevisionChangeRef = useRef(onRevisionChange);
  onRevisionChangeRef.current = onRevisionChange;

  /** The element that actually scrolls (CM scrolls its own scroller). */
  const scrollerOf = (): HTMLElement | null => {
    const host = hostRef.current;
    if (!host) {
      return null;
    }
    return (host.querySelector('.cm-scroller') as HTMLElement | null) ?? host;
  };

  /** Capture cursor + scroll for the currently open document. */
  const snapshotDocState = useCallback(() => {
    const docId = loadedDocIdRef.current;
    const session = sessionRef.current;
    const scroller = scrollerOf();
    if (!docId || !session || !scroller) {
      return;
    }
    const range = scroller.scrollHeight - scroller.clientHeight;
    onDocStateRef.current(docId, {
      cursor: session.getCursor(),
      scrollFraction: range > 0 ? scroller.scrollTop / range : 0,
    });
  }, []);

  const destroySession = useCallback(() => {
    scrollCleanupRef.current?.();
    scrollCleanupRef.current = null;
    if (scrollTimerRef.current) {
      clearTimeout(scrollTimerRef.current);
      scrollTimerRef.current = null;
    }
    sessionRef.current?.destroy();
    sessionRef.current = null;
  }, []);

  const createSession = useCallback(
    (text: string, forMode: EditorMode, documentId: string, restore?: UiStateDoc) => {
      const host = hostRef.current;
      if (!host) {
        return;
      }
      host.replaceChildren();
      const Options = {
        text,
        onFlush: (splices: Parameters<typeof window.texeris.doc.commit>[0]['splices']) => {
          setSaveState('saving');
          const commit = window.texeris.doc
            .commit({ documentId, splices, kind: 'typing' })
            .then(({ seq }) => {
              dirtyRef.current = false;
              setRevision(seq);
              onRevisionChangeRef.current(seq);
              setSaveState('saved');
            })
            .catch((err: unknown) => {
              commitErrorsRef.current.push(err);
              setSaveState('error');
              setNotice({
                text: `commit failed: ${err instanceof Error ? err.message : String(err)} — reloading`,
              });
              void reload();
            });
          pendingCommitsRef.current.add(commit);
          void commit.finally(() => pendingCommitsRef.current.delete(commit));
        },
        onDirty: () => {
          dirtyRef.current = true;
          setSaveState('dirty');
        },
        uploadImage: async (file: File) => {
          const mediaType = imageMediaType(file);
          const sourceName = file.name || `pasted-image.${mediaType.split('/')[1] || 'png'}`;
          return window.texeris.doc.addImage({
            documentId,
            sourceName,
            mediaType,
            dataBase64: await fileBase64(file),
          });
        },
        onImageError: (error: unknown) => {
          setNotice({ text: `image could not be added: ${error instanceof Error ? error.message : String(error)}` });
        },
      };
      const session = forMode === 'rendered' ? new RenderedSession(Options) : new RawSession(Options);
      session.mount(host);
      sessionRef.current = session;
      setActiveEditor(session instanceof RenderedSession ? session.getEditor() : null);
      if (restore?.cursor !== undefined) {
        session.setCursor(restore.cursor);
      }
      if (restore?.scrollFraction !== undefined) {
        const fraction = restore.scrollFraction;
        // Wait for layout before applying the scroll position.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const scroller = scrollerOf();
            if (scroller) {
              const range = scroller.scrollHeight - scroller.clientHeight;
              scroller.scrollTop = fraction * Math.max(0, range);
            }
          });
        });
      }
      // Persist view state as the user scrolls (debounced).
      const scroller = scrollerOf();
      if (scroller) {
        const onScroll = () => {
          if (scrollTimerRef.current) {
            clearTimeout(scrollTimerRef.current);
          }
          scrollTimerRef.current = setTimeout(snapshotDocState, 350);
        };
        scroller.addEventListener('scroll', onScroll, { passive: true });
        scrollCleanupRef.current = () => scroller.removeEventListener('scroll', onScroll);
      }
    },
    [snapshotDocState],
  );

  const openDocument = useCallback(
    async (documentId: string) => {
      const seq = ++openSeqRef.current;
      const doc = await window.texeris.doc.getText(documentId);
      if (seq !== openSeqRef.current) {
        return; // superseded by a newer open while awaiting
      }
      dirtyRef.current = false;
      setRevision(doc.revision);
      onRevisionChangeRef.current(doc.revision);
      setSaveState('saved');
      setSearchOpen(false);
      loadedDocIdRef.current = documentId;
      destroySession();
      createSession(doc.text, modeRef.current, documentId, docStatesRef.current[documentId]);
    },
    [createSession, destroySession],
  );

  const reload = useCallback(async () => {
    if (loadedDocIdRef.current) {
      await openDocument(loadedDocIdRef.current);
    }
  }, [openDocument]);

  // Open whatever document the shell hands down. Before leaving a document,
  // flush pending edits and snapshot its view state.
  useEffect(() => {
    if (!openDocId || openDocId === loadedDocIdRef.current) {
      return;
    }
    if (loadedDocIdRef.current) {
      sessionRef.current?.flush();
      snapshotDocState();
    }
    void openDocument(openDocId);
  }, [openDocId, openDocument, snapshotDocState]);

  // Selection bridge for the chat's selection scope.
  useEffect(() => {
    return registerSelectionGetter(() => sessionRef.current?.getSelection() ?? null);
  }, []);

  // Document statistics (M1.5 EU4): word count recomputed on change,
  // selection count continuously, both polled lightly (sessions have no
  // selection-change events of their own).
  useEffect(() => {
    const timer = setInterval(() => {
      const session = sessionRef.current;
      if (!session) {
        return;
      }
      const text = session.getText();
      if (text !== lastCountedTextRef.current) {
        lastCountedTextRef.current = text;
        setWordCount(countWords(text));
      }
      const selection = session.getSelectionText();
      setSelStats(
        selection ? { words: countWords(selection), chars: selection.length } : null,
      );
    }, 500);
    return () => clearInterval(timer);
  }, []);

  // Outline navigation bridge (EU2): the nav asks us to jump to a heading.
  useEffect(() => {
    return registerNavigateHandler((headingText) => {
      sessionRef.current?.navigateToHeading(headingText);
    });
  }, []);

  // Command surface (EU5): undo/redo/search/history/mode for the registry.
  useEffect(() => {
    return registerEditorCommands({
      undo: () => sessionRef.current?.undo() ?? false,
      redo: () => sessionRef.current?.redo() ?? false,
      openSearch: () => setSearchOpen(true),
      openCitationPicker: () => setCitationPicker({ mode: 'insert' }),
      toggleHistory: () => setShowHistory((v) => !v),
      toggleMode: () =>
        switchModeRef.current(modeRef.current === 'rendered' ? 'raw' : 'rendered'),
      flush: async () => {
        sessionRef.current?.flush();
        while (pendingCommitsRef.current.size > 0) {
          await Promise.all([...pendingCommitsRef.current]);
        }
        const errors = commitErrorsRef.current.splice(0);
        if (errors.length > 0) {
          throw errors.at(-1);
        }
      },
      contextAt: (x, y) => ({
        kind: 'editor',
        ...(sessionRef.current?.prepareContextAt(x, y) ?? { image: false, canUndo: false, canRedo: false }),
      }),
      contextAction: (action) => sessionRef.current?.contextAction(action) ?? false,
    });
  }, []);

  // Patch-review bridges: highlight ranges, reload after apply/undo.
  useEffect(() => {
    const offHighlight = registerHighlightHandler((ranges) => {
      sessionRef.current?.setHighlights(ranges);
    });
    const offReload = registerReloadHandler(() => {
      void reload();
    });
    return () => {
      offHighlight();
      offReload();
    };
  }, [reload]);

  // External-change events from main. When we have uncommitted edits, the
  // user decides explicitly: reload the external version (discarding the
  // uncommitted buffer — never a silent loss, plan §8) or keep editing.
  useEffect(() => {
    return window.texeris.doc.onEvent((event) => {
      if (event.documentId !== loadedDocIdRef.current) {
        return;
      }
      if (event.type === 'external-import') {
        if (dirtyRef.current) {
          setNotice({
            text: 'file changed on disk while you had unsaved edits — yours are kept in the editor',
            actionLabel: 'Reload external (discard my uncommitted edits)',
            onAction: () => {
              dirtyRef.current = false;
              void reload();
            },
          });
        } else {
          setNotice({ text: 'reloaded after an external edit' });
          void reload();
        }
      } else if (event.type === 'external-conflict') {
        setNotice({
          text: 'external edit arrived mid-commit — kept both versions, check history',
          actionLabel: 'Reload external (discard my uncommitted edits)',
          onAction: () => {
            dirtyRef.current = false;
            void reload();
          },
        });
      }
    });
  }, [reload]);

  const switchMode = (next: EditorMode) => {
    const docId = loadedDocIdRef.current;
    if (next === mode || !sessionRef.current || !docId) {
      return;
    }
    // Mode switch is not a revision: pending text changes flush as a normal
    // commit; the switch itself only swaps the view over the same text.
    // Scroll carries over so the user stays where they were. The cursor
    // does NOT carry over: the PM→canonical offset mapping is approximate
    // (prefix serialization), and a caret landing ±2 chars off would make
    // the next keystrokes corrupt text. Rendered→rendered restore across
    // restarts is self-consistent (binary-search inverse), so it stays.
    sessionRef.current.flush();
    const text = sessionRef.current.getText();
    const scroller = scrollerOf();
    const range = scroller ? scroller.scrollHeight - scroller.clientHeight : 0;
    const restore: UiStateDoc = {
      scrollFraction: scroller && range > 0 ? scroller.scrollTop / range : 0,
    };
    destroySession();
    setMode(next);
    modeRef.current = next;
    setSearchOpen(false);
    createSession(text, next, docId, restore);
    onModeChange(next);
  };

  const switchModeRef = useRef(switchMode);
  switchModeRef.current = switchMode;

  return (
    <section
      className="editor-region"
      onDoubleClick={(event) => {
        const target =
          event.target instanceof Element ? event.target.closest('.cite') : null;
        if (mode === 'rendered' && target && activeEditor) {
          const position = activeEditor.view.posAtDOM(target, 0);
          setCitationPicker({ mode: 'replace', position });
        }
      }}
      onKeyDownCapture={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
          e.preventDefault();
          setSearchOpen(true);
        } else if (
          (e.ctrlKey || e.metaKey) &&
          e.shiftKey &&
          e.key.toLowerCase() === 'c'
        ) {
          e.preventDefault();
          setCitationPicker({ mode: 'insert' });
        }
      }}
    >
      {activeEditor && (
        <Toolbar editor={activeEditor} onCite={() => setCitationPicker({ mode: 'insert' })} />
      )}
      <div className="editor-host" ref={hostRef} />
      {citationPicker && (
        <CitationPicker
          markdown={sessionRef.current?.getText() ?? ''}
          replacing={citationPicker.mode === 'replace'}
          onInsert={(key) => {
            if (citationPicker.mode === 'replace') {
              sessionRef.current?.replaceCitation(citationPicker.position, key);
            } else {
              sessionRef.current?.insertCitation(key);
            }
          }}
          onClose={() => setCitationPicker(null)}
        />
      )}
      {showHistory && openDocId && <HistoryPanel documentId={openDocId} />}
      {searchOpen && sessionRef.current && (
        <SearchPanel session={sessionRef.current} onClose={() => setSearchOpen(false)} />
      )}
      {notice && (
        <p className="editor-notice" onClick={() => setNotice(null)}>
          {notice.text}
          {notice.actionLabel && (
            <button
              className="notice-action"
              onClick={(e) => {
                e.stopPropagation();
                notice.onAction?.();
                setNotice(null);
              }}
            >
              {notice.actionLabel}
            </button>
          )}
        </p>
      )}
      <footer className="editor-status">
        <div className="toggle-group">
          {(['rendered', 'raw'] as const).map((m) => (
            <button
              key={m}
              className={mode === m ? 'active' : ''}
              disabled={revision === null}
              onClick={() => switchMode(m)}
            >
              {m === 'rendered' ? 'Rendered' : 'Raw'}
            </button>
          ))}
        </div>
        {workspaceStatus ? (
          <div
            className={`workspace-status-message status-${workspaceStatus.tone}`}
            role={workspaceStatus.tone === 'error' ? 'alert' : 'status'}
            title={workspaceStatus.message}
          >
            <span>{workspaceStatus.message}</span>
            {workspaceStatus.tone === 'progress' && workspaceStatus.onCancel && (
              <button
                type="button"
                className="status-cancel"
                onClick={workspaceStatus.onCancel}
              >
                Cancel
              </button>
            )}
            {workspaceStatus.tone !== 'progress' && (
              <button
                type="button"
                aria-label="Dismiss status message"
                onClick={onDismissWorkspaceStatus}
              >
                ×
              </button>
            )}
          </div>
        ) : (
          <span className="word-count">
            {wordCount !== null && `${wordCount.toLocaleString('en-US')} words`}
            {selStats &&
              ` · ${selStats.words.toLocaleString('en-US')} words, ${selStats.chars.toLocaleString('en-US')} chars selected`}
          </span>
        )}
        <div className="status-right">
          <span className="status-chip">
            {revision !== null ? `rev ${revision}` : '…'} ·{' '}
            {saveState === 'dirty' ? 'unsaved' : saveState}
          </span>
          {/* Document panels (find, history, …) dock at the bottom and are
              toggled by their status-bar button — keep that pattern for
              future panels. */}
          <button
            className={`history-toggle find-toggle ${searchOpen ? 'active' : ''}`}
            title="Find in document (Ctrl+F)"
            onClick={() => setSearchOpen((v) => !v)}
          >
            Find
          </button>
          <button
            className={`history-toggle ${showHistory ? 'active' : ''}`}
            title="Revision history"
            onClick={() => setShowHistory((v) => !v)}
          >
            History
          </button>
        </div>
      </footer>
    </section>
  );
}
