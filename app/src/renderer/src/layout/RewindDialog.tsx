import { useCallback, useEffect, useState } from 'react';
import type {
  RewindPoint,
  RewindPreview,
  RewindResult,
} from '../../../shared/rewind-types';
import { formatCompactDiff, lineDiff } from '../editor/lib/diff';

/**
 * Rewind dialog (G1 §8): pick an earlier completed turn or checkpoint,
 * preview the document/message boundary, then rewind. Turn points restore
 * the document as a new revision AND fork the conversation from the message
 * boundary; checkpoint points restore the document only. Follows the overlay
 * pattern — Esc or a backdrop click closes it.
 */
export default function RewindDialog({
  conversationId,
  documentId,
  initialSeq = null,
  onClose,
  onApplied,
}: {
  conversationId: string;
  /** The open document — its checkpoints are listed alongside turns. */
  documentId: string | null;
  /** Preselect the turn containing this message seq (message context menu). */
  initialSeq?: number | null;
  onClose(): void;
  onApplied(result: RewindResult): void;
}) {
  const [points, setPoints] = useState<RewindPoint[] | null>(null);
  const [selected, setSelected] = useState<RewindPoint | null>(null);
  const [preview, setPreview] = useState<RewindPreview | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const list = await window.texeris.rewind.list(
          conversationId,
          documentId ?? undefined,
        );
        setPoints(list);
        if (list.length > 0) {
          const preselected =
            initialSeq !== null
              ? (list.find(
                  (p) =>
                    p.kind === 'turn' &&
                    p.boundarySeq !== undefined &&
                    p.boundarySeq >= initialSeq,
                ) ?? list[0])
              : list[0];
          setSelected(preselected);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [conversationId, documentId, initialSeq]);

  useEffect(() => {
    if (!selected) {
      setPreview(null);
      return;
    }
    setPreview(null);
    void (async () => {
      try {
        setPreview(
          await window.texeris.rewind.preview({
            conversationId,
            kind: selected.kind,
            id: selected.id,
          }),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [conversationId, selected]);

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

  const apply = useCallback(async () => {
    if (!selected || applying) {
      return;
    }
    setApplying(true);
    setError(null);
    try {
      const result = await window.texeris.rewind.apply({
        conversationId,
        kind: selected.kind,
        id: selected.id,
      });
      onApplied(result);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setApplying(false);
    }
  }, [applying, conversationId, onApplied, onClose, selected]);

  const diff =
    preview && preview.currentText !== preview.targetText
      ? formatCompactDiff(lineDiff(preview.targetText, preview.currentText))
      : null;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel rewind-panel" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Rewind</h2>
          <button title="Close (Esc)" onClick={onClose}>
            ✕
          </button>
        </header>
        {error && (
          <p className="trash-error" title="Dismiss" onClick={() => setError(null)}>
            {error}
          </p>
        )}
        {points === null ? (
          <p className="settings-hint">Loading…</p>
        ) : points.length === 0 ? (
          <p className="settings-hint">
            No rewind points yet — completed agent turns and checkpoints appear
            here.
          </p>
        ) : (
          <div className="rewind-body">
            <ul className="rewind-list">
              {points.map((point) => (
                <li key={`${point.kind}:${point.id}`}>
                  <button
                    className={`rewind-point${selected?.id === point.id ? ' active' : ''}`}
                    onClick={() => setSelected(point)}
                  >
                    <span className="rewind-kind">
                      {point.kind === 'turn' ? '↩ turn' : '⚑ checkpoint'}
                    </span>
                    <span className="rewind-description" title={point.description}>
                      {point.description}
                    </span>
                    <span className="rewind-meta">
                      {point.targetRevision !== null ? `rev ${point.targetRevision} · ` : ''}
                      {new Date(point.createdAt).toLocaleString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="rewind-preview">
              {selected && (
                <>
                  <p className="settings-hint">
                    {selected.kind === 'turn'
                      ? 'Restores the document as a new revision and forks the conversation from this turn — the original conversation stays untouched.'
                      : 'Restores the document as a new revision. The conversation stays as is.'}
                  </p>
                  {preview === null ? (
                    <p className="settings-hint">Loading preview…</p>
                  ) : (
                    <>
                      {diff === null ? (
                        <p className="settings-hint">
                          The document already matches this point (rev{' '}
                          {preview.currentRevision}).
                        </p>
                      ) : (
                        <pre className="rewind-diff">{diff}</pre>
                      )}
                      {preview.pendingPatches.length > 0 && (
                        <p className="rewind-warning">
                          {preview.pendingPatches.length} pending patch(es) will
                          be kept and may conflict:{' '}
                          {preview.pendingPatches.map((p) => p.title).join(', ')}
                        </p>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        )}
        {points !== null && points.length > 0 && (
          <footer className="rewind-footer">
            <button className="trash-quiet" onClick={onClose}>
              Cancel
            </button>
            <button
              className="rewind-apply"
              disabled={!selected || preview === null || applying}
              onClick={() => void apply()}
            >
              {applying ? 'Rewinding…' : 'Rewind here'}
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
