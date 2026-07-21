import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteTrashedDocument,
  duplicateDocument,
  exportDocumentFile,
  importDocumentFile,
  listTrashedDocuments,
  renameDocument,
  restoreDocument,
  setMainDocument,
  trashDocument,
} from './documents';
import { CheckpointService } from './checkpoint';
import { PatchService } from './patch';
import { createProject, ensureDocument, openProject, type ProjectContext } from './project';

let root: string;
let ctx: ProjectContext;
let mainId: string;
let fakePandoc: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-docs-'));
  ctx = createProject(root);
  mainId = ensureDocument(ctx, 'manuscript.md');
  ctx.revisions.commit(mainId, [{ from: 0, to: 0, deletedText: '', insertedText: '# Main\n' }], {
    actor: 'user',
    source: { kind: 'typing' },
  });
  fakePandoc = path.join(root, 'fake-pandoc.sh');
  fs.writeFileSync(fakePandoc, `#!/bin/sh
for arg in "$@"; do
  case "$arg" in --output) next=1;; *) if [ "$next" = 1 ]; then output="$arg"; next=; fi;; esac
done
if [ -n "$output" ]; then cat > "$output"; else printf '# Converted\\n'; fi
`);
  fs.chmodSync(fakePandoc, 0o755);
  process.env.TEXERIS_PANDOC_PATH = fakePandoc;
});

afterEach(() => {
  delete process.env.TEXERIS_PANDOC_PATH;
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

  it('converts DOCX-like sources into a revisioned Markdown document', () => {
    const source = path.join(root, '..', 'paper.docx');
    fs.writeFileSync(source, 'binary placeholder');
    try {
      const imported = importDocumentFile(ctx, source);
      expect(imported.path).toBe('paper.md');
      expect(ctx.revisions.getTextAt(imported.id, 1)).toBe('# Converted\n');
      expect(imported.warnings).toHaveLength(1);
    } finally {
      fs.rmSync(source, { force: true });
    }
  });

  it('normalizes Pandoc-specific Markdown while leaving ordinary Markdown byte-exact', () => {
    const pandocSource = path.join(root, '..', `pandoc-${path.basename(root)}.md`);
    const ordinarySource = path.join(root, '..', `ordinary-${path.basename(root)}.md`);
    fs.writeFileSync(pandocSource, '[Underlined]{.underline}\n\n+:---:+\n| A |\n+---+\n');
    fs.writeFileSync(ordinarySource, '# Ordinary\n');
    try {
      const normalized = importDocumentFile(ctx, pandocSource);
      const ordinary = importDocumentFile(ctx, ordinarySource);
      expect(ctx.revisions.getTextAt(normalized.id, 1)).toBe('# Converted\n');
      expect(normalized.warnings.join(' ')).toMatch(/normalized/);
      expect(ctx.revisions.getTextAt(ordinary.id, 1)).toBe('# Ordinary\n');
      expect(ordinary.warnings).toHaveLength(0);
    } finally {
      fs.rmSync(pandocSource, { force: true });
      fs.rmSync(ordinarySource, { force: true });
    }
  });
});

describe('exportDocumentFile', () => {
  it('writes a DOCX derivative without changing the source document or revision', () => {
    const output = path.join(root, '..', `export-${path.basename(root)}.docx`);
    try {
      const result = exportDocumentFile(ctx, mainId, output);
      expect(result.format).toBe('docx');
      expect(fs.readFileSync(output, 'utf8')).toBe('# Main\n');
      expect(ctx.revisions.getTextAt(mainId, 1)).toBe('# Main\n');
      expect(result.warnings).toHaveLength(1);
    } finally {
      fs.rmSync(output, { force: true });
    }
  });

  it('warns about unrendered citations and refuses to overwrite the canonical file', () => {
    const id = makeDoc('cited.md', 'A claim [@source].\n');
    const output = path.join(root, '..', `export-${path.basename(root)}.rtf`);
    try {
      expect(exportDocumentFile(ctx, id, output).warnings.join(' ')).toMatch(/bibliography/);
      expect(() => exportDocumentFile(ctx, id, path.join(root, 'cited.md'))).toThrow(/different path/);
    } finally {
      fs.rmSync(output, { force: true });
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

// ------------------------------------------------------------- EU7: trash

function rowCount(table: string, documentId: string): number {
  const row = ctx.db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE document_id = ?`)
    .get(documentId) as { n: number };
  return row.n;
}

describe('listTrashedDocuments', () => {
  it('lists trashed docs with their trash date, skipping live ones', () => {
    makeDoc('keep.md');
    trashDocument(ctx, makeDoc('a.md'));
    trashDocument(ctx, makeDoc('b.md'));
    const list = listTrashedDocuments(ctx);
    expect(new Set(list.map((d) => d.path))).toEqual(new Set(['a.md', 'b.md']));
    expect(list.every((d) => d.trashedAt.length > 0)).toBe(true);
  });
});

describe('restoreDocument', () => {
  it('moves the file back, clears trashed_at, keeps id and history', () => {
    const id = makeDoc('draft.md', 'hello\n');
    trashDocument(ctx, id);
    const restored = restoreDocument(ctx, id);
    expect(restored).toMatchObject({ id, path: 'draft.md', title: 'draft' });
    expect(fs.readFileSync(path.join(root, 'draft.md'), 'utf8')).toBe('hello\n');
    expect(
      ctx.db.prepare('SELECT trashed_at FROM documents WHERE id = ?').get(id),
    ).toMatchObject({ trashed_at: null });
    expect(ctx.revisions.getTextAt(id, 1)).toBe('hello\n');
    expect(listTrashedDocuments(ctx)).toHaveLength(0);
  });

  it('restores under a new name when the original path was taken', () => {
    const id = makeDoc('draft.md', 'old\n');
    trashDocument(ctx, id);
    fs.writeFileSync(path.join(root, 'draft.md'), 'new\n'); // external newcomer
    const restored = restoreDocument(ctx, id);
    expect(restored.path).toBe('draft (restored).md');
    expect(fs.readFileSync(path.join(root, 'draft.md'), 'utf8')).toBe('new\n');
    expect(fs.readFileSync(path.join(root, 'draft (restored).md'), 'utf8')).toBe('old\n');
  });

  it('refuses a live document and reports a missing trash file', () => {
    const id = makeDoc('draft.md');
    expect(() => restoreDocument(ctx, id)).toThrow(/not in the trash/);
    trashDocument(ctx, id);
    fs.rmSync(path.join(root, '.texeris', 'trash', `${id}.md`));
    expect(() => restoreDocument(ctx, id)).toThrow(/missing/);
  });
});

describe('deleteTrashedDocument', () => {
  it('removes the row, history, checkpoints, patches, and the trash file', () => {
    const id = makeDoc('draft.md', 'text\n');
    new CheckpointService(ctx.db, ctx.revisions).create(id, 'before the end');
    const proposed = new PatchService(ctx.db, ctx.revisions).propose(
      {
        baseRevision: 1,
        title: 't',
        summary: 's',
        groups: [
          {
            explanation: 'e',
            changes: [{ from: 0, to: 4, expectedText: 'text', insert: 'word' }],
          },
        ],
        documentId: id,
      },
      { conversationId: 'c1', agentRunId: 'r1' },
    );
    expect(proposed).toHaveProperty('patchId');
    trashDocument(ctx, id);

    deleteTrashedDocument(ctx, id);

    for (const table of ['revisions', 'revision_changes', 'checkpoints', 'patches']) {
      expect(rowCount(table, id), table).toBe(0);
    }
    expect(
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM documents WHERE id = ?').get(id) as { n: number }).n,
    ).toBe(0);
    // no orphaned patch rows pointing at deleted patches/groups
    for (const orphanQuery of [
      'SELECT COUNT(*) AS n FROM patch_groups WHERE patch_id NOT IN (SELECT id FROM patches)',
      'SELECT COUNT(*) AS n FROM patch_changes WHERE group_id NOT IN (SELECT id FROM patch_groups)',
    ]) {
      expect((ctx.db.prepare(orphanQuery).get() as { n: number }).n).toBe(0);
    }
    expect(fs.existsSync(path.join(root, '.texeris', 'trash', `${id}.md`))).toBe(false);
  });

  it('refuses to delete a live document', () => {
    const id = makeDoc('draft.md');
    expect(() => deleteTrashedDocument(ctx, id)).toThrow(/not in the trash/);
  });

  it('project open still works afterwards', () => {
    const id = makeDoc('draft.md');
    trashDocument(ctx, id);
    deleteTrashedDocument(ctx, id);
    ctx.db.close();
    const reopened = openProject(root);
    ctx = reopened; // afterEach closes it
    expect(reopened.project.mainDocument).toBe('manuscript.md');
  });
});
