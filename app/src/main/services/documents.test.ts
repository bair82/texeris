import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  duplicateDocument,
  importDocumentFile,
  renameDocument,
  setMainDocument,
  trashDocument,
} from './documents';
import { createProject, ensureDocument, openProject, type ProjectContext } from './project';

let root: string;
let ctx: ProjectContext;
let mainId: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-docs-'));
  ctx = createProject(root);
  mainId = ensureDocument(ctx, 'manuscript.md');
  ctx.revisions.commit(mainId, [{ from: 0, to: 0, deletedText: '', insertedText: '# Main\n' }], {
    actor: 'user',
    source: { kind: 'typing' },
  });
});

afterEach(() => {
  ctx.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function makeDoc(name: string, content = 'text\n'): string {
  fs.writeFileSync(path.join(root, name), '');
  const id = ensureDocument(ctx, name);
  ctx.revisions.commit(id, [{ from: 0, to: 0, deletedText: '', insertedText: content }], {
    actor: 'user',
    source: { kind: 'import' },
  });
  return id;
}

describe('renameDocument', () => {
  it('moves the file and updates the row — id stays the same', () => {
    const id = makeDoc('notes.md');
    const renamed = renameDocument(ctx, id, 'journal.md');
    expect(renamed).toMatchObject({ id, path: 'journal.md', title: 'journal' });
    expect(fs.existsSync(path.join(root, 'notes.md'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'journal.md'), 'utf8')).toBe('text\n');
    const row = ctx.db.prepare('SELECT path FROM documents WHERE id = ?').get(id);
    expect(row).toMatchObject({ path: 'journal.md' });
  });

  it('updates project.json when the main document is renamed', () => {
    renameDocument(ctx, mainId, 'paper.md');
    expect(ctx.project.mainDocument).toBe('paper.md');
    const json = JSON.parse(
      fs.readFileSync(path.join(root, '.texeris', 'project.json'), 'utf8'),
    );
    expect(json.mainDocument).toBe('paper.md');
  });

  it('refuses an existing name and invalid names', () => {
    const id = makeDoc('a.md');
    makeDoc('b.md');
    expect(() => renameDocument(ctx, id, 'b.md')).toThrow(/already exists/);
    expect(() => renameDocument(ctx, id, '../evil.md')).toThrow(/invalid document name/);
    expect(() => renameDocument(ctx, id, 'no-extension')).toThrow(/invalid document name/);
  });
});

describe('trashDocument', () => {
  it('moves the file to .texeris/trash and marks the row', () => {
    const id = makeDoc('draft.md');
    trashDocument(ctx, id);
    expect(fs.existsSync(path.join(root, 'draft.md'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.texeris', 'trash', `${id}.md`))).toBe(true);
    const row = ctx.db
      .prepare('SELECT trashed_at FROM documents WHERE id = ?')
      .get(id) as { trashed_at: string | null };
    expect(row.trashed_at).not.toBeNull();
  });

  it('keeps revision history for a later restore', () => {
    const id = makeDoc('draft.md');
    trashDocument(ctx, id);
    expect(ctx.revisions.getTextAt(id, 1)).toBe('text\n');
  });

  it('refuses the main document and double-trashing', () => {
    expect(() => trashDocument(ctx, mainId)).toThrow(/main document/);
    const id = makeDoc('draft.md');
    trashDocument(ctx, id);
    expect(() => trashDocument(ctx, id)).toThrow(/trash/);
  });

  it('does not break project open (reconciliation skips trashed docs)', () => {
    const id = makeDoc('draft.md');
    trashDocument(ctx, id);
    ctx.db.close();
    const reopened = openProject(root); // must not throw on the missing file
    ctx = reopened; // afterEach closes it
    expect(reopened.project.mainDocument).toBe('manuscript.md');
  });
});

describe('duplicateDocument', () => {
  it('copies content under "<name> copy.md" with its own id and rev 1', () => {
    const id = makeDoc('notes.md', 'hello\n');
    const dup = duplicateDocument(ctx, id);
    expect(dup.path).toBe('notes copy.md');
    expect(dup.id).not.toBe(id);
    expect(fs.readFileSync(path.join(root, 'notes copy.md'), 'utf8')).toBe('hello\n');
    expect(ctx.revisions.getTextAt(dup.id, 1)).toBe('hello\n');
  });

  it('numbers further duplicates', () => {
    const id = makeDoc('notes.md');
    duplicateDocument(ctx, id);
    const second = duplicateDocument(ctx, id);
    expect(second.path).toBe('notes copy 2.md');
  });
});

describe('importDocumentFile', () => {
  it('copies an external file into the project with rev 1', () => {
    const source = path.join(root, '..', `import-${path.basename(root)}.md`);
    fs.writeFileSync(source, '# External\n');
    try {
      const imported = importDocumentFile(ctx, source);
      expect(imported.path).toBe(`import-${path.basename(root)}.md`);
      expect(ctx.revisions.getTextAt(imported.id, 1)).toBe('# External\n');
    } finally {
      fs.rmSync(source, { force: true });
    }
  });

  it('renames on conflict instead of overwriting', () => {
    makeDoc('notes.md', 'mine\n');
    const source = path.join(root, '..', 'notes.md');
    fs.writeFileSync(source, 'theirs\n');
    try {
      const imported = importDocumentFile(ctx, source);
      expect(imported.path).toBe('notes-2.md');
      expect(fs.readFileSync(path.join(root, 'notes.md'), 'utf8')).toBe('mine\n');
    } finally {
      fs.rmSync(source, { force: true });
    }
  });
});

describe('setMainDocument', () => {
  it('updates project.json', () => {
    const id = makeDoc('paper.md');
    setMainDocument(ctx, id);
    expect(ctx.project.mainDocument).toBe('paper.md');
    const json = JSON.parse(
      fs.readFileSync(path.join(root, '.texeris', 'project.json'), 'utf8'),
    );
    expect(json.mainDocument).toBe('paper.md');
  });

  it('refuses a trashed document', () => {
    const id = makeDoc('paper.md');
    trashDocument(ctx, id);
    expect(() => setMainDocument(ctx, id)).toThrow(/trash/);
  });
});
