import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckpointService } from './checkpoint';
import { createProject, ensureDocument, type ProjectContext } from './project';

let root: string;
let ctx: ProjectContext;
let checkpoints: CheckpointService;
let docId: string;
let docPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-cp-'));
  ctx = createProject(root);
  checkpoints = new CheckpointService(ctx.db, ctx.revisions);
  docId = ensureDocument(ctx, 'manuscript.md');
  docPath = path.join(root, 'manuscript.md');
});

afterEach(() => {
  ctx.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function type(text: string, at: number): void {
  ctx.revisions.commit(docId, [{ from: at, to: at, deletedText: '', insertedText: text }], {
    actor: 'user',
    source: { kind: 'typing' },
  });
}

describe('CheckpointService', () => {
  it('creates a named durable snapshot at the current revision', () => {
    type('chapter one', 0);
    const cp = checkpoints.create(docId, 'first draft');
    expect(cp.revisionSeq).toBe(1);
    expect(cp.name).toBe('first draft');

    const listed = checkpoints.list(docId);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(cp.id);

    const stored = ctx.db
      .prepare('SELECT snapshot_text FROM checkpoints WHERE id = ?')
      .get(cp.id) as { snapshot_text: string };
    expect(stored.snapshot_text).toBe('chapter one');
  });

  it('refuses to checkpoint a document with no revisions', () => {
    expect(() => checkpoints.create(docId, 'too early')).toThrow(/no revisions/);
  });

  it('round-trips an optional human-readable description (rewind picker)', () => {
    type('chapter one', 0);
    const described = checkpoints.create(docId, 'first draft', 'before agent edits');
    expect(described.description).toBe('before agent edits');
    const plain = checkpoints.create(docId, 'second');
    expect(plain.description).toBe('');

    const listed = checkpoints.list(docId);
    expect(listed.map((cp) => cp.description)).toEqual(['before agent edits', '']);
  });

  it('restores a checkpoint as a new revision (append-only)', () => {
    type('v1 text', 0);
    const cp = checkpoints.create(docId, 'v1');
    type(' plus more', 'v1 text'.length);
    expect(fs.readFileSync(docPath, 'utf8')).toBe('v1 text plus more');

    const newSeq = checkpoints.restore(cp.id);
    expect(newSeq).toBe(3);
    expect(fs.readFileSync(docPath, 'utf8')).toBe('v1 text');
    // the pre-restore state is still in history
    expect(ctx.revisions.getTextAt(docId, 2)).toBe('v1 text plus more');
  });
});
