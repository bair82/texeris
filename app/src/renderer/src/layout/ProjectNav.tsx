import { useEffect, useState } from 'react';
import type { DocumentInfo } from '../../../shared/domain-types';
import type { HeadingInfo } from '../../../shared/doc-types';

interface ProjectNavProps {
  width: number;
  docs: DocumentInfo[];
  openDocId: string | null;
  /** Committed revision of the open doc — the outline refetches on change. */
  openDocRevision: number;
  onOpenDoc(documentId: string): void;
  /** Create a document and open it; throws on failure (shown inline). */
  onCreateDoc(name: string): Promise<void>;
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
 * Left navigation region (M1.5): the project's Markdown files and the open
 * document's heading outline (EU2) with click-to-scroll.
 */
export default function ProjectNav({
  width,
  docs,
  openDocId,
  openDocRevision,
  onOpenDoc,
  onCreateDoc,
  onNavigate,
}: ProjectNavProps) {
  const [creating, setCreating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [headings, setHeadings] = useState<HeadingInfo[]>([]);

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
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <nav className="project-nav" style={{ width }}>
      <header className="nav-header">
        <span className="nav-title">Files</span>
        <button
          className="nav-action"
          title="New document"
          onClick={() => setCreating('')}
        >
          +
        </button>
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
          <li key={d.id}>
            <button
              className={`nav-file ${d.id === openDocId ? 'active' : ''}`}
              title={d.path}
              onClick={() => onOpenDoc(d.id)}
            >
              <FileGlyph />
              <span className="nav-file-path">{d.path}</span>
            </button>
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
