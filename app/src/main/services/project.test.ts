import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createProject,
  createDocument,
  ensureDocument,
  openProject,
  PROJECT_FORMAT_VERSION,
  type ProjectContext,
} from './project';
import { restoreDocument, trashDocument } from './documents';
import { UiStateService } from './uiState';
import { WELCOME_DOCUMENT } from './welcome';

let root: string;
const created: ProjectContext[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-proj-'));
});

afterEach(() => {
  while (created.length) {
    created.pop()?.db.close();
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function create(): ProjectContext {
  const ctx = createProject(root);
  created.push(ctx);
  return ctx;
}

describe('createProject', () => {
  it('creates .texeris/project.json, history.sqlite and the main document', () => {
    const ctx = create();
    expect(ctx.project.formatVersion).toBe(PROJECT_FORMAT_VERSION);
    expect(ctx.project.projectId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fs.existsSync(path.join(root, '.texeris', 'project.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.texeris', 'history.sqlite'))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'manuscript.md'), 'utf8')).toBe('');
    expect(ensureDocument(ctx, 'manuscript.md')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses to create over an existing project', () => {
    create();
    expect(() => createProject(root)).toThrow(/already exists/);
  });

  it('seeds welcome.md as rev 1 and opens new projects on it', () => {
    const ctx = create();
    const row = ctx.db
      .prepare('SELECT id FROM documents WHERE path = ?')
      .get(WELCOME_DOCUMENT) as { id: string } | undefined;
    expect(row?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ctx.revisions.getCurrentText(row!.id)).toContain('# Welcome to Texeris');
    expect(new UiStateService(ctx.db).get().openDocumentId).toBe(row!.id);
  });

  it('registers an existing welcome.md without overwriting it', () => {
    fs.writeFileSync(path.join(root, WELCOME_DOCUMENT), 'my own welcome\n');
    const ctx = create();
    const row = ctx.db
      .prepare('SELECT id FROM documents WHERE path = ?')
      .get(WELCOME_DOCUMENT) as { id: string };
    expect(fs.readFileSync(path.join(root, WELCOME_DOCUMENT), 'utf8')).toBe(
      'my own welcome\n',
    );
    expect(ctx.revisions.getCurrentText(row.id)).toBe('my own welcome\n');
  });
});

describe('openProject', () => {
  it('reopens the same project identity', () => {
    const ctx = create();
    const reopened = openProject(root);
    created.push(reopened);
    expect(reopened.project.projectId).toBe(ctx.project.projectId);
  });

  it('rejects an unknown format version', () => {
    create();
    const file = path.join(root, '.texeris', 'project.json');
    const json = JSON.parse(fs.readFileSync(file, 'utf8')) as { formatVersion: number };
    json.formatVersion = 99;
    fs.writeFileSync(file, JSON.stringify(json));
    expect(() => openProject(root)).toThrow(/format version 99/);
  });

  it('cleans orphan tmp files and never chooses them as content', () => {
    const ctx = create();
    const docId = ensureDocument(ctx, 'manuscript.md');
    ctx.revisions.commit(docId, [{ from: 0, to: 0, deletedText: '', insertedText: 'safe' }], {
      actor: 'user',
      source: { kind: 'typing' },
    });
    // simulate an interrupted atomic write
    fs.writeFileSync(path.join(root, 'manuscript.md.texeris-tmp-1234-0'), 'partial!');

    const reopened = openProject(root);
    created.push(reopened);
    expect(fs.existsSync(path.join(root, 'manuscript.md.texeris-tmp-1234-0'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'manuscript.md'), 'utf8')).toBe('safe');
    expect(reopened.revisions.getCurrentRevision(docId)).toBe(1);
  });

  it('imports edits made while the app was closed as external revisions', () => {
    const ctx = create();
    const docId = ensureDocument(ctx, 'manuscript.md');
    ctx.revisions.commit(docId, [{ from: 0, to: 0, deletedText: '', insertedText: 'draft' }], {
      actor: 'user',
      source: { kind: 'typing' },
    });
    ctx.db.close();
    created.length = 0;
    fs.writeFileSync(path.join(root, 'manuscript.md'), 'draft edited elsewhere');

    const reopened = openProject(root);
    created.push(reopened);
    expect(reopened.revisions.getCurrentRevision(docId)).toBe(2);
    expect(reopened.revisions.getTextAt(docId, 2)).toBe('draft edited elsewhere');
    const latest = reopened.revisions.listRevisions(docId)[0];
    expect(latest.actor).toBe('external');
  });

  it('createDocument creates and registers a new markdown file', () => {
    const ctx = create();
    const doc = createDocument(ctx, 'notes.md');
    expect(doc.path).toBe('notes.md');
    expect(fs.readFileSync(path.join(root, 'notes.md'), 'utf8')).toBe('');
    expect(ensureDocument(ctx, 'notes.md')).toBe(doc.id);

    expect(() => createDocument(ctx, '../escape.md')).toThrow(/invalid document name/);
    expect(() => createDocument(ctx, 'no-extension.txt')).toThrow(/invalid document name/);
  });

  it('createDocument refuses a path owned by a trashed document', () => {
    const ctx = create();
    const doc = createDocument(ctx, 'notes.md');
    trashDocument(ctx, doc.id);
    expect(() => createDocument(ctx, 'notes.md')).toThrow(/trash/);
    restoreDocument(ctx, doc.id);
    expect(createDocument(ctx, 'notes.md').id).toBe(doc.id);
  });
});
