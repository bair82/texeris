import { useCallback, useEffect, useState } from 'react';
import { diffWords } from 'diff';
import type { PatchRecord } from '../../shared/patch-types';
import { highlightInEditor, reloadEditor } from './editor/editorBridge';

/**
 * PatchReview (plan §12, D0 feedback): what changes where must be visually
 * obvious — per-group word diffs with explanations, per-group accept/reject,
 * accept-all, in-editor highlight of affected ranges, and one-click undo of
 * an accepted patch (restore-as-new-revision).
 */
export default function PatchReview() {
  const [patches, setPatches] = useState<PatchRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [undoable, setUndoable] = useState<{ label: string; previousSeq: number } | null>(null);

  const refresh = useCallback(async () => {
    setPatches(await window.texeris.patch.list());
  }, []);

  useEffect(() => {
    void refresh();
    return window.texeris.patch.onEvent(() => {
      void refresh();
    });
  }, [refresh]);

  const act = useCallback(
    async (fn: () => Promise<unknown>, after?: () => void) => {
      setError(null);
      try {
        const result = await fn();
        if (result && typeof result === 'object' && 'conflict' in result) {
          setError('patch no longer applies cleanly — marked as conflict; ask the agent to regenerate');
        }
        await refresh();
        after?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
  );

  /** Accept (all or a subset) and arm one-click undo for the new revision. */
  const acceptAndTrack = useCallback(
    (patch: PatchRecord, groupIds?: string[]) =>
      act(async () => {
        const result = await window.texeris.patch.accept(patch.id, groupIds);
        if (result && 'seq' in result) {
          setUndoable({
            label: `Accepted “${patch.title}” → rev ${result.seq}.`,
            previousSeq: result.previousSeq,
          });
          reloadEditor();
        }
      }),
    [act],
  );

  const pending = patches.filter(
    (p) => p.status === 'proposed' || p.status === 'partial',
  );

  if (pending.length === 0 && !undoable && !error) {
    return null;
  }

  return (
    <aside className="patch-review">
      {error && <p className="chat-error">{error}</p>}
      {undoable && (
        <p className="patch-undo">
          {undoable.label}{' '}
          <button
            onClick={() =>
              act(
                async () => {
                  await window.texeris.doc.restore(undoable.previousSeq);
                },
                () => {
                  setUndoable(null);
                  reloadEditor();
                },
              )
            }
          >
            Undo
          </button>
        </p>
      )}
      {pending.map((patch) => (
        <div key={patch.id} className="patch-card">
          <header>
            <strong>{patch.title}</strong>
            <span className="manifest-chip">base rev {patch.baseRevision}</span>
          </header>
          <p className="patch-summary">{patch.summary}</p>
          {patch.groups.map((group) =>
            group.status !== 'pending' ? null : (
              <div key={group.id} className="patch-group">
                <p className="patch-explanation">{group.explanation}</p>
                {group.changes.map((change, i) => (
                  <WordDiff key={i} expected={change.expectedText} insert={change.insert} />
                ))}
                <div className="patch-actions">
                  <button
                    title="Show affected ranges in the editor"
                    onClick={() =>
                      highlightInEditor(
                        group.changes.map((c) => ({
                          from: c.from,
                          to: c.to,
                          snippet: c.expectedText,
                        })),
                      )
                    }
                  >
                    Show
                  </button>
                  <button onClick={() => acceptAndTrack(patch, [group.id])}>
                    Accept
                  </button>
                  <button
                    onClick={() => act(() => window.texeris.patch.reject(patch.id, [group.id]))}
                  >
                    Reject
                  </button>
                </div>
              </div>
            ),
          )}
          <div className="patch-actions patch-all">
            <button onClick={() => acceptAndTrack(patch)}>
              Accept all
            </button>
            <button onClick={() => act(() => window.texeris.patch.reject(patch.id))}>
              Reject all
            </button>
          </div>
        </div>
      ))}
    </aside>
  );
}

function WordDiff({ expected, insert }: { expected: string; insert: string }) {
  const parts = diffWords(expected, insert);
  return (
    <pre className="patch-diff">
      {parts.map((part, i) => (
        <span
          key={i}
          className={part.added ? 'diff-add' : part.removed ? 'diff-del' : undefined}
        >
          {part.value}
        </span>
      ))}
    </pre>
  );
}
