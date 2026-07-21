import { useEffect, useRef, useState } from 'react';
import type { DocumentInfo } from '../../../shared/domain-types';
import type { HeadingInfo } from '../../../shared/doc-types';

interface ProjectNavProps {
  width: number;
  docs: DocumentInfo[];
  openDocId: string | null;
  /** Path of the project's main document (marked, cannot be trashed). */
  mainPath: string;
  /** Committed revision of the open doc — the outline refetches on change. */
  openDocRevision: number;
  /** Increment to open the new-document form (command registry, EU5). */
  newDocRequested: number;
  onOpenDoc(documentId: string): void;
  /** Create a document and open it; throws on failure (shown inline). */
  onCreateDoc(name: string): Promise<void>;
  onRenameDoc(documentId: string, name: string): Promise<void>;
  onTrashDoc(documentId: string): Promise<void>;
  onDuplicateDoc(documentId: string): Promise<void>;
  onImportDoc(): Promise<void>;
  onSetMainDoc(documentId: string): Promise<void>;
  onRevealDoc(documentId: string): Promise<void>;
  /** Jump to a heading in the editor (EU2). */
  onNavigate(headingText: string): void;
}

function FileGlyph() {
  return (
    <svg
      className="nav-file-icon"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

/**
 * Left navigation region (M1.5): the project's Markdown files with
 * management actions (EU3: rename/duplicate/trash/import/set-main/reveal)
 * and the open document's heading outline (EU2) with click-to-scroll.
 */
export default function ProjectNav({
  width,
  docs,
  openDocId,
  mainPath,
  openDocRevision,
  newDocRequested,
  onOpenDoc,
  onCreateDoc,
  onRenameDoc,
  onTrashDoc,
  onDuplicateDoc,
  onImportDoc,
  onSetMainDoc,
  onRevealDoc,
  onNavigate,
}: ProjectNavProps) {
  const [creating, setCreating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [headings, setHeadings] = useState<HeadingInfo[]>([]);
  const [menuDocId, setMenuDocId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirmTrashId, setConfirmTrashId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // The command registry opens the new-document form via a counter.
  useEffect(() => {
    if (newDocRequested > 0) {
      setCreating('');
    }
  }, [newDocRequested]);

  // Refetch the outline on doc switch and after commits (debounced).
  useEffect(() => {
    if (!openDocId) {
      setHeadings([]);
      return;
    }
    const timer = setTimeout(() => {
      window.texeris.doc
        .outline(openDocId)
        .then(setHeadings)
        .catch(() => setHeadings([]));
    }, 350);
    return () => clearTimeout(timer);
  }, [openDocId, openDocRevision]);

  // Close the row menu on any outside click.
  useEffect(() => {
    if (!menuDocId) {
      return;
    }
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) {
        setMenuDocId(null);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuDocId]);

  const reportError = (err: unknown) => {
    setError(err instanceof Error ? err.message : String(err));
  };

  const submit = async () => {
    const name = (creating ?? '').trim();
    if (!name) {
      setCreating(null);
      return;
    }
    try {
      await onCreateDoc(name);
      setCreating(null);
      setError(null);
    } catch (err) {
      reportError(err);
    }
  };

  const submitRename = async () => {
    if (!renaming) {
      return;
    }
    const name = renaming.name.trim();
    if (!name) {
      setRenaming(null);
      return;
    }
    try {
      await onRenameDoc(renaming.id, name.endsWith('.md') ? name : `${name}.md`);
      setRenaming(null);
      setError(null);
    } catch (err) {
      reportError(err);
    }
  };

  return (
    <nav className="project-nav" style={{ width }}>
      <header className="nav-header">
        <span className="nav-title">Files</span>
        <span className="nav-header-actions">
          <button
            className="nav-action import-action"
            title="Import a Markdown file…"
            onClick={() => void onImportDoc().catch(reportError)}
          >
            ⇩
          </button>
          <button
            className="nav-action"
            title="New document"
            onClick={() => setCreating('')}
          >
            +
          </button>
        </span>
      </header>
      {creating !== null && (
        <div className="nav-new-form">
          <input
            autoFocus
            placeholder="notes.md"
            value={creating}
            onChange={(e) => setCreating(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                void submit();
              } else if (e.key === 'Escape') {
                setCreating(null);
              }
            }}
          />
        </div>
      )}
      {error && (
        <p className="nav-error" title="Dismiss" onClick={() => setError(null)}>
          {error}
        </p>
      )}
      <ul className="nav-files">
        {docs.map((d) => (
          <li key={d.id} className="nav-file-row">
            {renaming?.id === d.id ? (
              <span className="nav-rename-form">
                <input
                  autoFocus
                  value={renaming.name}
                  onChange={(e) => setRenaming({ id: d.id, name: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      void submitRename();
                    } else if (e.key === 'Escape') {
                      setRenaming(null);
                    }
                  }}
                />
              </span>
            ) : confirmTrashId === d.id ? (
              <span className="nav-confirm">
                <span className="nav-confirm-text">Move to trash?</span>
                <button
                  className="nav-confirm-yes"
                  onClick={() => {
                    setConfirmTrashId(null);
                    void onTrashDoc(d.id).catch(reportError);
                  }}
                >
                  Trash
                </button>
                <button className="nav-confirm-no" onClick={() => setConfirmTrashId(null)}>
                  Keep
                </button>
              </span>
            ) : (
              <>
                <button
                  className={`nav-file ${d.id === openDocId ? 'active' : ''}`}
                  title={d.path}
                  onClick={() => onOpenDoc(d.id)}
                >
                  <FileGlyph />
                  <span className="nav-file-path">{d.path}</span>
                  {d.path === mainPath && (
                    <span className="nav-main-dot" title="Main document" />
                  )}
                </button>
                <div className="nav-menu-wrap" ref={menuDocId === d.id ? menuRef : undefined}>
                  <button
                    className="nav-file-menu-btn"
                    title="Document actions"
                    onClick={() => setMenuDocId(menuDocId === d.id ? null : d.id)}
                  >
                    ⋯
                  </button>
                  {menuDocId === d.id && (
                    <div className="nav-menu">
                      <button onClick={() => { setMenuDocId(null); setRenaming({ id: d.id, name: d.path }); }}>
                        Rename…
                      </button>
                      <button onClick={() => { setMenuDocId(null); void onDuplicateDoc(d.id).catch(reportError); }}>
                        Duplicate
                      </button>
                      <button onClick={() => { setMenuDocId(null); void onRevealDoc(d.id).catch(reportError); }}>
                        Reveal in Files
                      </button>
                      {d.path !== mainPath && (
                        <button onClick={() => { setMenuDocId(null); void onSetMainDoc(d.id).catch(reportError); }}>
                          Set as main document
                        </button>
                      )}
                      {d.path !== mainPath && (
                        <button
                          className="nav-menu-danger"
                          onClick={() => { setMenuDocId(null); setConfirmTrashId(d.id); }}
                        >
                          Move to trash…
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
      {headings.length > 0 && (
        <div className="nav-outline">
          <header className="nav-header">
            <span className="nav-title">Outline</span>
          </header>
          <ul className="nav-headings">
            {headings.map((h) => (
              <li key={`${h.line}:${h.text}`}>
                <button
                  className="nav-heading"
                  style={{ paddingLeft: 8 + (h.level - 1) * 12 }}
                  title={h.text}
                  onClick={() => onNavigate(h.text)}
                >
                  {h.text}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </nav>
  );
}
