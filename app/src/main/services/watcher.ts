import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DocEvent } from '../../shared/doc-types';
import type { ProjectContext } from './project';
import { ensureDocument } from './project';

/**
 * External-change watching (plan §8): watch project files; when a file's
 * hash differs from the last known revision and no commit is in flight,
 * import it as an `external` revision and tell the UI to reload. Our own
 * atomic writes are naturally filtered — the hash check sees them as
 * unchanged. A commit in flight yields a conflict notice instead (never
 * overwrite external edits).
 */
export function watchProjectFiles(
  project: ProjectContext,
  onEvent: (event: DocEvent) => void,
): () => void {
  const watchers: fs.FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const check = () => {
    const docId = ensureDocument(project, project.project.mainDocument);
    const result = project.revisions.importExternalChange(docId);
    if (result.kind === 'imported') {
      onEvent({ type: 'external-import', revision: result.seq });
    } else if (result.kind === 'conflict') {
      onEvent({ type: 'external-conflict' });
    }
  };

  const file = path.join(project.root, project.project.mainDocument);
  const watcher = fs.watch(file, { persistent: false }, () => {
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
