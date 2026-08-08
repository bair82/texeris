import { useCallback, useEffect, useState } from 'react';
import type { CheckpointInfo, RevisionInfo } from '../../../shared/domain-types';
import { reloadEditor } from './editorBridge';

/**
 * HistoryPanel (plan §12): revision timeline for the open document with
 * actor badges and summaries, restore-as-new-revision, and checkpoints
 * (named durable snapshots) with restore. Checkpoints are collapsed by
 * default — creating one is a single click with a generated name and
 * description (owner request 2026-08-08); rename inline if ever needed.
 */
export default function HistoryPanel({ documentId }: { documentId: string }) {
  const [revisions, setRevisions] = useState<RevisionInfo[]>([]);
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renameDescription, setRenameDescription] = useState('');
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

  /** One click — name and description are generated. */
  const createCheckpoint = async () => {
    setError(null);
    try {
      await window.texeris.history.createCheckpoint({ documentId });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const startRename = (cp: CheckpointInfo) => {
    setRenamingId(cp.id);
    setRenameName(cp.name);
    setRenameDescription(cp.description);
  };

  const submitRename = async () => {
    if (!renamingId) {
      return;
    }
    const name = renameName.trim();
    setError(null);
    try {
      if (name) {
        await window.texeris.history.renameCheckpoint(renamingId, {
          name,
          description: renameDescription.trim(),
        });
      }
      setRenamingId(null);
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
      <details className="checkpoint-section">
        <summary>Checkpoints ({checkpoints.length})</summary>
        <div className="checkpoint-form">
          <button onClick={() => void createCheckpoint()}>Checkpoint now</button>
          <span className="history-meta">name + description are generated</span>
        </div>
        {checkpoints.length > 0 && (
          <ul className="checkpoint-list">
            {checkpoints.map((cp) => (
              <li key={cp.id}>
                {renamingId === cp.id ? (
                  <span className="checkpoint-rename">
                    <input
                      autoFocus
                      value={renameName}
                      onChange={(e) => setRenameName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          void submitRename();
                        } else if (e.key === 'Escape') {
                          setRenamingId(null);
                        }
                      }}
                    />
                    <input
                      placeholder="description…"
                      value={renameDescription}
                      onChange={(e) => setRenameDescription(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          void submitRename();
                        } else if (e.key === 'Escape') {
                          setRenamingId(null);
                        }
                      }}
                    />
                  </span>
                ) : (
                  <>
                    <span className="checkpoint-name">⚑ {cp.name}</span>
                    {cp.description && (
                      <span className="history-meta" title={cp.description}>
                        {cp.description}
                      </span>
                    )}
                  </>
                )}
                <span className="history-meta">rev {cp.revisionSeq}</span>
                {renamingId !== cp.id && (
                  <button title="Rename checkpoint" onClick={() => startRename(cp)}>
                    ✎
                  </button>
                )}
                <button onClick={() => void restoreCheckpoint(cp.id)}>Restore</button>
              </li>
            ))}
          </ul>
        )}
      </details>
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
