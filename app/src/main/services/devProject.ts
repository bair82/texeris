import * as fs from 'node:fs';
import * as path from 'node:path';
import { createProject, openProject, type ProjectContext } from './project';
import { workspaceDir } from './settings';

/**
 * WP3 dev harness: the app works against one development project until the
 * project-open UI lands (WP2/M1 flow). Location: TEXERIS_PROJECT_DIR or
 * <workspace config dir>/dev-project. Seeded with a short manuscript so the
 * agent has material to read.
 */
export function openDevProject(): ProjectContext {
  const root =
    process.env.TEXERIS_PROJECT_DIR ?? path.join(workspaceDir(), 'dev-project');
  if (fs.existsSync(path.join(root, '.texeris', 'project.json'))) {
    return openProject(root);
  }
  const ctx = createProject(root);
  const manuscript = [
    '# The Geometry of Attention',
    '',
    '## Introduction',
    '',
    'Attention mechanisms have reshaped sequence modeling, yet their',
    'geometric interpretation remains underexplored [@vaswani2017].',
    '',
    '## Related work',
    '',
    'Earlier approaches treated attention as soft alignment [@bahdanau2015].',
    'We instead study the manifold structure induced by attention maps.',
    '',
    '## Method',
    '',
    'We probe attention heads as points on a Grassmann manifold and measure',
    'geodesic distances between layers.',
    '',
  ].join('\n');
  ctx.revisions.commit(
    ctx.db
      .prepare('SELECT id FROM documents WHERE path = ?')
      .get(ctx.project.mainDocument)!.id as string,
    [{ from: 0, to: 0, deletedText: '', insertedText: manuscript }],
    { actor: 'user', source: { kind: 'import' } },
  );
  return ctx;
}
