import { useCallback, useEffect, useRef, useState } from 'react';
import type { EditorMode, EditorSession } from './session';
import { RawSession, RenderedSession } from './session';
import {
  registerHighlightHandler,
  registerReloadHandler,
  registerSelectionGetter,
} from './editorBridge';

type SaveState = 'loading' | 'saved' | 'dirty' | 'saving' | 'error';

interface EditorNotice {
  text: string;
  actionLabel?: string;
  onAction?: () => void;
}

/**
 * The editor region (plan §12): rendered mode default with a raw toggle,
 * commit-on-group over IPC (autosave), external-change reload, and a status
 * bar with revision + save state. The session abstraction owns the two
 * editing modes over one canonical text.
 */
export default function EditorRegion() {
  const hostRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<EditorSession | null>(null);
  const [mode, setMode] = useState<EditorMode>('rendered');
  const [revision, setRevision] = useState<number | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('loading');
  const [notice, setNotice] = useState<EditorNotice | null>(null);
  const dirtyRef = useRef(false);

  const destroySession = useCallback(() => {
    sessionRef.current?.destroy();
    sessionRef.current = null;
  }, []);

  const createSession = useCallback(
    (text: string, forMode: EditorMode) => {
      const host = hostRef.current;
      if (!host) {
        return;
      }
      host.replaceChildren();
      const Options = {
        text,
        onFlush: (splices: Parameters<typeof window.texeris.doc.commit>[0]['splices']) => {
          setSaveState('saving');
          window.texeris.doc
            .commit({ splices, kind: 'typing' })
            .then(({ seq }) => {
              dirtyRef.current = false;
              setRevision(seq);
              setSaveState('saved');
            })
            .catch((err: unknown) => {
              setSaveState('error');
              setNotice({
                text: `commit failed: ${err instanceof Error ? err.message : String(err)} — reloading`,
              });
              void reload();
            });
        },
        onDirty: () => {
          dirtyRef.current = true;
          setSaveState('dirty');
        },
      };
      const session = forMode === 'rendered' ? new RenderedSession(Options) : new RawSession(Options);
      session.mount(host);
      sessionRef.current = session;
    },
    [],
  );

  const reload = useCallback(async () => {
    const doc = await window.texeris.doc.getText();
    dirtyRef.current = false;
    setRevision(doc.revision);
    setSaveState('saved');
    destroySession();
    createSession(doc.text, mode);
  }, [createSession, destroySession, mode]);

  // Initial load.
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Selection bridge for the chat's selection scope.
  useEffect(() => {
    return registerSelectionGetter(() => sessionRef.current?.getSelection() ?? null);
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
    if (next === mode || !sessionRef.current) {
      return;
    }
    // Mode switch is not a revision: pending text changes flush as a normal
    // commit; the switch itself only swaps the view over the same text.
    sessionRef.current.flush();
    const text = sessionRef.current.getText();
    destroySession();
    setMode(next);
    createSession(text, next);
  };

  return (
    <section className="editor-region">
      <div className="editor-host" ref={hostRef} />
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
            <button key={m} className={mode === m ? 'active' : ''} onClick={() => switchMode(m)}>
              {m === 'rendered' ? 'Rendered' : 'Raw'}
            </button>
          ))}
        </div>
        <span className="status-chip">
          {revision !== null ? `rev ${revision}` : '…'} · {saveState}
        </span>
      </footer>
    </section>
  );
}
