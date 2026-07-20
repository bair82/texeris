import { useState } from 'react';
import type { DocumentInfo } from '../../../shared/domain-types';

interface ProjectNavProps {
  width: number;
  docs: DocumentInfo[];
  openDocId: string | null;
  onOpenDoc(documentId: string): void;
  /** Create a document and open it; throws on failure (shown inline). */
  onCreateDoc(name: string): Promise<void>;
}

/**
 * Left navigation region (M1.5 EU1, plan §12): the project's Markdown files.
 * A heading outline joins this region in EU2.
 */
export default function ProjectNav({
  width,
  docs,
  openDocId,
  onOpenDoc,
  onCreateDoc,
}: ProjectNavProps) {
  const [creating, setCreating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
              <span className="nav-file-path">{d.path}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
