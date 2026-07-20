import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { minimalSplice } from '../../shared/text-splice';
import { atomicWriteText, hashText } from './document';
import type { ProjectContext } from './project';

/**
 * Document management (M1.5 EU3): rename (ids never change), trash (file
 * moves to `.texeris/trash/`, row + history kept for restore), duplicate,
 * import from disk, and the main-document designation. The file remains
 * the canonical text — every operation keeps the file, the documents row,
 * and (for the main doc) project.json in sync.
 */

const SAFE_NAME = /^[\w .-]+\.md$/i;
const TRASH_DIR = '.texeris/trash';

export interface DocumentHandle {
  id: string;
  path: string;
  title: string;
}

interface DocumentRow {
  id: string;
  path: string;
  title: string;
  trashed_at: string | null;
}

function docRow(ctx: ProjectContext, documentId: string): DocumentRow {
  const row = ctx.db
    .prepare('SELECT id, path, title, trashed_at FROM documents WHERE id = ?')
    .get(documentId) as DocumentRow | undefined;
  if (!row) {
    throw new Error(`unknown document: ${documentId}`);
  }
  return row;
}

function titleFor(relativePath: string): string {
  return path.basename(relativePath).replace(/\.md$/i, '');
}

function assertValidName(name: string): string {
  const trimmed = name.trim();
  if (!SAFE_NAME.test(trimmed) || trimmed.includes('..') || path.isAbsolute(trimmed)) {
    throw new Error(
      `invalid document name ${JSON.stringify(name)} — use a simple relative path ending in .md`,
    );
  }
  return trimmed;
}

function assertLive(row: DocumentRow): void {
  if (row.trashed_at !== null) {
    throw new Error(`document is in the trash: ${row.path}`);
  }
}

function pathTaken(ctx: ProjectContext, relativePath: string): boolean {
  if (fs.existsSync(path.join(ctx.root, relativePath))) {
    return true;
  }
  return (
    ctx.db.prepare('SELECT 1 AS x FROM documents WHERE path = ?').get(relativePath) !==
    undefined
  );
}

/**
 * Rename = move the file and update the row; the document id never changes,
 * so open editors, patches, and history stay attached. Renaming the main
 * document also updates project.json.
 */
export function renameDocument(
  ctx: ProjectContext,
  documentId: string,
  newName: string,
): DocumentHandle {
  const row = docRow(ctx, documentId);
  assertLive(row);
  const target = assertValidName(newName);
  if (target === row.path) {
    return { id: row.id, path: row.path, title: row.title };
  }
  if (pathTaken(ctx, target)) {
    throw new Error(`a document named ${target} already exists`);
  }
  const from = path.join(ctx.root, row.path);
  const to = path.join(ctx.root, target);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  ctx.db
    .prepare('UPDATE documents SET path = ?, title = ? WHERE id = ?')
    .run(target, titleFor(target), row.id);
  if (ctx.project.mainDocument === row.path) {
    ctx.project.mainDocument = target;
    atomicWriteText(
      path.join(ctx.root, '.texeris', 'project.json'),
      JSON.stringify(ctx.project, null, 2) + '\n',
    );
  }
  return { id: row.id, path: target, title: titleFor(target) };
}

/**
 * Trash: the file moves to `.texeris/trash/<id>.md`; the row (and all
 * revision history) stays, marked with trashed_at — EU7 restores from this.
 * The main document cannot be trashed (the agent reads it).
 */
export function trashDocument(ctx: ProjectContext, documentId: string): void {
  const row = docRow(ctx, documentId);
  assertLive(row);
  if (ctx.project.mainDocument === row.path) {
    throw new Error('the main document cannot be trashed');
  }
  const trashDir = path.join(ctx.root, TRASH_DIR);
  fs.mkdirSync(trashDir, { recursive: true });
  fs.renameSync(path.join(ctx.root, row.path), path.join(trashDir, `${row.id}.md`));
  ctx.db
    .prepare('UPDATE documents SET trashed_at = ? WHERE id = ?')
    .run(new Date().toISOString(), row.id);
}

/** Duplicate under "<name> copy.md" (numbered when taken), new id + history. */
export function duplicateDocument(ctx: ProjectContext, documentId: string): DocumentHandle {
  const row = docRow(ctx, documentId);
  assertLive(row);
  const base = row.path.replace(/\.md$/i, '');
  let target = `${base} copy.md`;
  for (let n = 2; pathTaken(ctx, target); n++) {
    target = `${base} copy ${n}.md`;
  }
  const content = fs.readFileSync(path.join(ctx.root, row.path), 'utf8');
  const id = registerImported(ctx, target, content, `duplicate of ${row.path}`);
  return { id, path: target, title: titleFor(target) };
}

/** Copy a Markdown file from anywhere into the project root. */
export function importDocumentFile(ctx: ProjectContext, sourcePath: string): DocumentHandle {
  const original = path.basename(sourcePath);
  const base = original.replace(/\.md$/i, '');
  let target = `${base}.md`;
  for (let n = 2; pathTaken(ctx, target); n++) {
    target = `${base}-${n}.md`;
  }
  const content = fs.readFileSync(sourcePath, 'utf8');
  const id = registerImported(ctx, target, content, `imported from ${original}`);
  return { id, path: target, title: titleFor(target) };
}

/** Register a file-backed document and record its content as rev 1. */
function registerImported(
  ctx: ProjectContext,
  relativePath: string,
  content: string,
  summary: string,
): string {
  // the commit writes the file — start from the canonical empty state
  atomicWriteText(path.join(ctx.root, relativePath), '');
  const id = randomUUID();
  ctx.db
    .prepare(
      `INSERT INTO documents (id, path, title, created_at, current_revision, content_hash)
       VALUES (?, ?, ?, ?, 0, ?)`,
    )
    .run(id, relativePath, titleFor(relativePath), new Date().toISOString(), hashText(''));
  ctx.revisions.commit(id, [minimalSplice('', content)], {
    actor: 'user',
    source: { kind: 'import' },
    summary,
  });
  return id;
}

/** Designate an existing live document as the project's main document. */
export function setMainDocument(ctx: ProjectContext, documentId: string): DocumentHandle {
  const row = docRow(ctx, documentId);
  assertLive(row);
  if (ctx.project.mainDocument !== row.path) {
    ctx.project.mainDocument = row.path;
    atomicWriteText(
      path.join(ctx.root, '.texeris', 'project.json'),
      JSON.stringify(ctx.project, null, 2) + '\n',
    );
  }
  return { id: row.id, path: row.path, title: row.title };
}
