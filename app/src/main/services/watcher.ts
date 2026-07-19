import * as fs from 'node:fs';
import type { DocEvent } from '../../shared/doc-types';
import type { ProjectContext } from './project';

/**
 * External-change watching (plan §8): watch the project directory; when any
 * registered document's hash differs from its last known revision and no
 * commit is in flight, import it as an `external` revision and tell the UI.
 * Our own atomic writes are naturally filtered — the hash check sees them
 * as unchanged. A commit in flight yields a conflict notice instead (never
 * overwrite external edits).
 */
export function watchProjectFiles(
  project: ProjectContext,
  onEvent: (event: DocEvent) => void,
): () => void {
  const watchers: fs.FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const check = () => {
    const docs = project.db
      .prepare('SELECT id FROM documents')
      .all() as unknown as Array<{ id: string }>;
    for (const doc of docs) {
      const result = project.revisions.importExternalChange(doc.id);
      if (result.kind === 'imported') {
        onEvent({ type: 'external-import', documentId: doc.id, revision: result.seq });
      } else if (result.kind === 'conflict') {
        onEvent({ type: 'external-conflict', documentId: doc.id });
      }
    }
  };

  const watcher = fs.watch(project.root, { persistent: false }, () => {
    // Debounce: editors/write tools often emit several events per write.
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      try {
        check();
      } catch {
        // file briefly unavailable mid-write; the next event will retry
      }
    }, 250);
  });
  watchers.push(watcher);

  return () => {
    if (timer) {
      clearTimeout(timer);
    }
    for (const w of watchers) {
      w.close();
    }
  };
}
