import { useCallback, useEffect, useState } from 'react';
import type { TrashedDocumentInfo } from '../../../shared/doc-types';

/**
 * Trash dialog (M1.5 EU7): trashed documents with restore (the document
 * resumes under the same id with its whole history) and permanent delete
 * (no way back). Follows the overlay pattern — Esc or a backdrop click
 * closes it.
 */
export default function TrashDialog({
  onClose,
  onRestored,
}: {
  onClose(): void;
  /** A document came back to life — the shell refreshes the nav and opens it. */
  onRestored(doc: { id: string; path: string; title: string }): void;
}) {
  const [items, setItems] = useState<TrashedDocumentInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setItems(await window.texeris.doc.trashList());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const reportError = (err: unknown) =>
    setError(err instanceof Error ? err.message : String(err));

  const restore = async (id: string) => {
    try {
      const doc = await window.texeris.doc.restoreTrash(id);
      await refresh();
      onRestored(doc);
    } catch (err) {
      reportError(err);
    }
  };

  const deleteForever = async (id: string) => {
    try {
      await window.texeris.doc.deleteTrash(id);
      setConfirmDeleteId(null);
      await refresh();
    } catch (err) {
      reportError(err);
    }
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel trash-panel" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Trash</h2>
          <button title="Close (Esc)" onClick={onClose}>
            ✕
          </button>
        </header>
        {error && (
          <p className="trash-error" title="Dismiss" onClick={() => setError(null)}>
            {error}
          </p>
        )}
        {items === null ? (
          <p className="settings-hint">Loading…</p>
        ) : items.length === 0 ? (
          <p className="settings-hint">The trash is empty.</p>
        ) : (
          <ul className="trash-list">
            {items.map((item) => (
              <li key={item.id} className="trash-row">
                <span className="trash-doc">
                  <span className="trash-doc-path" title={item.path}>
                    {item.path}
                  </span>
                  <span className="trash-doc-date">
                    {new Date(item.trashedAt).toLocaleString()}
                  </span>
                </span>
                {confirmDeleteId === item.id ? (
                  <span className="trash-actions">
                    <span className="trash-confirm-text">Delete forever?</span>
                    <button
                      className="trash-danger"
                      onClick={() => void deleteForever(item.id)}
                    >
                      Delete
                    </button>
                    <button className="trash-quiet" onClick={() => setConfirmDeleteId(null)}>
                      Keep
                    </button>
                  </span>
                ) : (
                  <span className="trash-actions">
                    <button className="trash-quiet" onClick={() => void restore(item.id)}>
                      Restore
                    </button>
                    <button
                      className="trash-quiet trash-delete"
                      onClick={() => setConfirmDeleteId(item.id)}
                    >
                      Delete…
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="settings-hint">
          Restored documents keep their whole revision history. Permanent
          deletion removes the file, the history, and any checkpoints — there
          is no way back.
        </p>
      </div>
    </div>
  );
}
