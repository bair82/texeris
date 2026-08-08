import { useCallback, useEffect, useState } from 'react';
import type { CheckpointInfo, RevisionInfo } from '../../../shared/domain-types';
import { reloadEditor } from './editorBridge';

/**
 * HistoryPanel (plan §12): revision timeline for the open document with
 * actor badges and summaries, restore-as-new-revision, and checkpoints
 * (named durable snapshots) with restore.
 */
export default function HistoryPanel({ documentId }: { documentId: string }) {
  const [revisions, setRevisions] = useState<RevisionInfo[]>([]);
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);
  const [checkpointName, setCheckpointName] = useState('');
  const [checkpointDescription, setCheckpointDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRevisions(await window.texeris.history.revisions(documentId));
    setCheckpoints(await window.texeris.history.listCheckpoints(documentId));
  }, [documentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const restoreRevision = async (revision: number) => {
    setError(null);
    try {
      await window.texeris.doc.restore(revision, documentId);
      reloadEditor();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const createCheckpoint = async () => {
    const name = checkpointName.trim();
    if (!name) {
      return;
    }
    setError(null);
    try {
      await window.texeris.history.createCheckpoint(
        name,
        documentId,
        checkpointDescription.trim() || undefined,
      );
      setCheckpointName('');
      setCheckpointDescription('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const restoreCheckpoint = async (checkpointId: string) => {
    setError(null);
    try {
      await window.texeris.history.restoreCheckpoint(checkpointId);
      reloadEditor();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="history-panel">
      {error && <p className="chat-error">{error}</p>}
      <div className="checkpoint-form">
        <input
          placeholder="checkpoint name…"
          value={checkpointName}
          onChange={(e) => setCheckpointName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              void createCheckpoint();
            }
          }}
        />
        <input
          placeholder="short description (optional)…"
          value={checkpointDescription}
          onChange={(e) => setCheckpointDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              void createCheckpoint();
            }
          }}
        />
        <button disabled={!checkpointName.trim()} onClick={() => void createCheckpoint()}>
          Checkpoint
        </button>
      </div>
      {checkpoints.length > 0 && (
        <ul className="checkpoint-list">
          {checkpoints.map((cp) => (
            <li key={cp.id}>
              <span className="checkpoint-name">⚑ {cp.name}</span>
              {cp.description && (
                <span className="history-meta" title={cp.description}>
                  {cp.description}
                </span>
              )}
              <span className="history-meta">rev {cp.revisionSeq}</span>
              <button onClick={() => void restoreCheckpoint(cp.id)}>Restore</button>
            </li>
          ))}
        </ul>
      )}
      <ul className="revision-list">
        {revisions.map((rev) => (
          <li key={rev.seq}>
            <span className={`actor-badge actor-${rev.actor}`}>{rev.actor}</span>
            <span className="history-meta">
              rev {rev.seq} · {new Date(rev.createdAt).toLocaleString()}
            </span>
            <span className="history-summary" title={rev.summary}>
              {rev.summary}
            </span>
            {rev.source.kind === 'patch' && <span className="history-meta">⚙ patch</span>}
            <button onClick={() => void restoreRevision(rev.seq)}>Restore</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
