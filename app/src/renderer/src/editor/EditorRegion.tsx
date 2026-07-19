import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import type { DocumentInfo } from '../../../shared/domain-types';
import type { EditorMode, EditorSession } from './session';
import { RawSession, RenderedSession } from './session';
import {
  registerHighlightHandler,
  registerReloadHandler,
  registerSelectionGetter,
} from './editorBridge';
import Toolbar from './Toolbar';

type SaveState = 'loading' | 'saved' | 'dirty' | 'saving' | 'error';

interface EditorNotice {
  text: string;
  actionLabel?: string;
  onAction?: () => void;
}

/**
 * The editor region (plan §12): rendered mode default with a raw toggle,
 * commit-on-group over IPC (autosave), external-change reload, a document
 * switcher with new-document creation, and a status bar with revision +
 * save state. The session abstraction owns the two editing modes over one
 * canonical text.
 */
export default function EditorRegion() {
  const hostRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<EditorSession | null>(null);
  const [mode, setMode] = useState<EditorMode>('rendered');
  const [docs, setDocs] = useState<DocumentInfo[]>([]);
  const [openDocId, setOpenDocId] = useState<string | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('loading');
  const [notice, setNotice] = useState<EditorNotice | null>(null);
  const [newDocName, setNewDocName] = useState<string | null>(null);
  const [activeEditor, setActiveEditor] = useState<Editor | null>(null);
  const dirtyRef = useRef(false);
  const openDocIdRef = useRef<string | null>(null);
  openDocIdRef.current = openDocId;

  const refreshDocs = useCallback(async () => {
    setDocs(await window.texeris.doc.list());
  }, []);

  const destroySession = useCallback(() => {
    sessionRef.current?.destroy();
    sessionRef.current = null;
  }, []);

  const createSession = useCallback(
    (text: string, forMode: EditorMode, documentId: string) => {
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
            .commit({ documentId, splices, kind: 'typing' })
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
      setActiveEditor(session instanceof RenderedSession ? session.getEditor() : null);
    },
    [],
  );

  const openDocument = useCallback(
    async (documentId: string) => {
      const doc = await window.texeris.doc.getText(documentId);
      dirtyRef.current = false;
      setRevision(doc.revision);
      setSaveState('saved');
      setOpenDocId(documentId);
      destroySession();
      createSession(doc.text, mode, documentId);
    },
    [createSession, destroySession, mode],
  );

  const reload = useCallback(async () => {
    if (openDocIdRef.current) {
      await openDocument(openDocIdRef.current);
    }
  }, [openDocument]);

  // Initial load: document list + main document.
  useEffect(() => {
    void (async () => {
      const list = await window.texeris.doc.list();
      setDocs(list);
      if (list[0]) {
        await openDocument(list[0].id);
      }
    })();
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
      void refreshDocs();
      if (event.documentId !== openDocIdRef.current) {
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
  }, [reload, refreshDocs]);

  const switchMode = (next: EditorMode) => {
    if (next === mode || !sessionRef.current || !openDocId) {
      return;
    }
    // Mode switch is not a revision: pending text changes flush as a normal
    // commit; the switch itself only swaps the view over the same text.
    sessionRef.current.flush();
    const text = sessionRef.current.getText();
    destroySession();
    setMode(next);
    createSession(text, next, openDocId);
  };

  const switchDocument = (documentId: string) => {
    if (documentId === openDocId) {
      return;
    }
    sessionRef.current?.flush();
    void openDocument(documentId);
  };

  const createNewDocument = async () => {
    const name = (newDocName ?? '').trim();
    if (!name) {
      setNewDocName(null);
      return;
    }
    try {
      const created = await window.texeris.doc.create(name.endsWith('.md') ? name : `${name}.md`);
      setNewDocName(null);
      await refreshDocs();
      const list = await window.texeris.doc.list();
      const createdDoc = list.find((d) => d.id === created.id);
      if (createdDoc) {
        switchDocument(createdDoc.id);
      }
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <section className="editor-region">
      <div className="doc-bar">
        <select
          className="doc-select"
          value={openDocId ?? ''}
          onChange={(e) => switchDocument(e.target.value)}
        >
          {docs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.path}
            </option>
          ))}
        </select>
        {newDocName === null ? (
          <button className="doc-new" title="New document" onClick={() => setNewDocName('')}>
            + New
          </button>
        ) : (
          <span className="doc-new-form">
            <input
              autoFocus
              placeholder="notes.md"
              value={newDocName}
              onChange={(e) => setNewDocName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void createNewDocument();
                } else if (e.key === 'Escape') {
                  setNewDocName(null);
                }
              }}
            />
            <button onClick={() => void createNewDocument()}>Create</button>
          </span>
        )}
      </div>
      {activeEditor && <Toolbar editor={activeEditor} />}
      <div className="editor-host" ref={hostRef} />      {notice && (
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
        <span className="status-chip">
          {revision !== null ? `rev ${revision}` : '…'} · {saveState}
        </span>
      </footer>
    </section>
  );
}
