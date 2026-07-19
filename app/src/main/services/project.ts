import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../db/database';
import {
  atomicWriteText,
  cleanOrphanTmpFiles,
  hashText,
} from './document';
import { RevisionService } from './revision';

/**
 * Project service (plan §4.8, §7.1): a project is a user folder with a
 * `.texeris/` directory holding project.json and history.sqlite. Documents
 * are addressed by uuid in the DB and looked up by relative path on open.
 */

export const PROJECT_FORMAT_VERSION = 1;
const PROJECT_DIR = '.texeris';
const PROJECT_FILE = 'project.json';
const DB_FILE = 'history.sqlite';

export interface ProjectJson {
  formatVersion: number;
  projectId: string;
  mainDocument: string;
}

export interface ProjectContext {
  root: string;
  project: ProjectJson;
  db: DatabaseSync;
  revisions: RevisionService;
}

function texerisDir(root: string): string {
  return path.join(root, PROJECT_DIR);
}

function writeProjectJson(root: string, project: ProjectJson): void {
  atomicWriteText(
    path.join(texerisDir(root), PROJECT_FILE),
    JSON.stringify(project, null, 2) + '\n',
  );
}

function readProjectJson(root: string): ProjectJson {
  const raw = fs.readFileSync(path.join(texerisDir(root), PROJECT_FILE), 'utf8');
  const parsed = JSON.parse(raw) as Partial<ProjectJson>;
  if (
    typeof parsed.formatVersion !== 'number' ||
    typeof parsed.projectId !== 'string' ||
    typeof parsed.mainDocument !== 'string'
  ) {
    throw new Error(`invalid ${PROJECT_FILE} in ${root}`);
  }
  if (parsed.formatVersion !== PROJECT_FORMAT_VERSION) {
    throw new Error(
      `unsupported project format version ${parsed.formatVersion} ` +
        `(this build understands ${PROJECT_FORMAT_VERSION})`,
    );
  }
  return parsed as ProjectJson;
}

function titleFor(relativePath: string): string {
  return path.basename(relativePath).replace(/\.md$/i, '');
}

function registerDocument(db: DatabaseSync, relativePath: string): string {
  const existing = db
    .prepare('SELECT id FROM documents WHERE path = ?')
    .get(relativePath) as { id: string } | undefined;
  if (existing) {
    return existing.id;
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO documents (id, path, title, created_at, current_revision, content_hash)
     VALUES (?, ?, ?, ?, 0, ?)`,
  ).run(id, relativePath, titleFor(relativePath), new Date().toISOString(), hashText(''));
  return id;
}

/** Create a new project folder with a main document and an empty history. */
export function createProject(root: string, mainDocument = 'manuscript.md'): ProjectContext {
  fs.mkdirSync(texerisDir(root), { recursive: true });
  const projectFile = path.join(texerisDir(root), PROJECT_FILE);
  if (fs.existsSync(projectFile)) {
    throw new Error(`project already exists at ${root}`);
  }
  const project: ProjectJson = {
    formatVersion: PROJECT_FORMAT_VERSION,
    projectId: randomUUID(),
    mainDocument,
  };
  writeProjectJson(root, project);
  const docPath = path.join(root, mainDocument);
  if (!fs.existsSync(docPath)) {
    atomicWriteText(docPath, '');
  }
  const db = openDatabase(path.join(texerisDir(root), DB_FILE));
  registerDocument(db, mainDocument);
  return { root, project, db, revisions: new RevisionService(db, root) };
}

/**
 * Open an existing project. Startup reconciliation (plan §4.10): orphan tmp
 * files from interrupted writes are cleaned (never chosen as content), and
 * documents whose file hash differs from the last known revision are
 * imported as external revisions.
 */
export function openProject(root: string): ProjectContext {
  const project = readProjectJson(root);
  const db = openDatabase(path.join(texerisDir(root), DB_FILE));
  const revisions = new RevisionService(db, root);
  const ctx: ProjectContext = { root, project, db, revisions };

  cleanOrphanTmpFiles(root);
  const docs = db
    .prepare('SELECT id, path FROM documents')
    .all() as Array<{ id: string; path: string }>;
  for (const doc of docs) {
    cleanOrphanTmpFiles(path.dirname(path.join(root, doc.path)));
    revisions.importExternalChange(doc.id);
  }
  return ctx;
}

/** Look up a document id by relative path, registering it if it is new. */
export function ensureDocument(ctx: ProjectContext, relativePath: string): string {
  return registerDocument(ctx.db, relativePath);
}
