import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TextSplice } from '../../shared/domain-types';
import { CheckpointService } from './checkpoint';
import { PatchService } from './patch';
import { createProject, ensureDocument, type ProjectContext } from './project';
import { SNAPSHOT_EVERY, TIP_AMEND_WINDOW_MS } from './revision';

let ctx: ProjectContext;
let root: string;
let docId: string;
let docPath: string;

function typing(insertedText: string, at: number): TextSplice {
  return { from: at, to: at, deletedText: '', insertedText };
}

function readFile(): string {
  return fs.readFileSync(docPath, 'utf8');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-rev-'));
  ctx = createProject(root);
  docId = ensureDocument(ctx, 'manuscript.md');
  docPath = path.join(root, 'manuscript.md');
});

afterEach(() => {
  ctx.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('RevisionService.commit', () => {
  it('applies splices, writes the file, and records the revision', () => {
    const seq = ctx.revisions.commit(docId, [typing('hello', 0)], {
      actor: 'user',
      source: { kind: 'typing' },
    });
    expect(seq).toBe(1);
    expect(readFile()).toBe('hello');
    expect(ctx.revisions.getCurrentRevision(docId)).toBe(1);

    // consecutive user typing coalesces into the tip revision (one
    // revision per sitting — see the tip-amend tests below)
    const seq2 = ctx.revisions.commit(
      docId,
      [{ from: 5, to: 5, deletedText: '', insertedText: ' world' }],
      { actor: 'user', source: { kind: 'typing' } },
    );
    expect(seq2).toBe(1);
    expect(readFile()).toBe('hello world');
    expect(ctx.revisions.getTextAt(docId, 1)).toBe('hello world');
  });

  it('rejects a splice whose deletedText does not match — file and DB untouched', () => {
    ctx.revisions.commit(docId, [typing('hello', 0)], {
      actor: 'user',
      source: { kind: 'typing' },
    });
    expect(() =>
      ctx.revisions.commit(
        docId,
        [{ from: 0, to: 5, deletedText: 'HELLO', insertedText: 'x' }],
        { actor: 'user', source: { kind: 'typing' } },
      ),
    ).toThrow(/splice validation failed/);
    expect(readFile()).toBe('hello');
    expect(ctx.revisions.getCurrentRevision(docId)).toBe(1);
  });

  it('rejects out-of-range splices', () => {
    expect(() =>
      ctx.revisions.commit(
        docId,
        [{ from: 0, to: 10, deletedText: '', insertedText: 'x' }],
        { actor: 'user', source: { kind: 'typing' } },
      ),
    ).toThrow(/invalid splice range/);
  });

  it('applies splices within one group sequentially', () => {
    ctx.revisions.commit(docId, [typing('abcdef', 0)], {
      actor: 'user',
      source: { kind: 'typing' },
    });
    const seq = ctx.revisions.commit(
      docId,
      [
        { from: 6, to: 6, deletedText: '', insertedText: 'X' }, // abcdefX
        { from: 0, to: 1, deletedText: 'a', insertedText: 'A' }, // AbcdefX
      ],
      { actor: 'user', source: { kind: 'typing' } },
    );
    expect(readFile()).toBe('AbcdefX');
    expect(ctx.revisions.getTextAt(docId, seq)).toBe('AbcdefX');
  });

  it('treats an empty change group as an error (mode switches create no revision)', () => {
    expect(() =>
      ctx.revisions.commit(docId, [], { actor: 'user', source: { kind: 'typing' } }),
    ).toThrow(/empty change group/);
    expect(ctx.revisions.getCurrentRevision(docId)).toBe(0);
  });

  it('ignores no-op commits', () => {
    ctx.revisions.commit(docId, [typing('hello', 0)], {
      actor: 'user',
      source: { kind: 'typing' },
    });
    const seq = ctx.revisions.commit(
      docId,
      [{ from: 0, to: 5, deletedText: 'hello', insertedText: 'hello' }],
      { actor: 'user', source: { kind: 'typing' } },
    );
    expect(seq).toBe(1);
    expect(ctx.revisions.getCurrentRevision(docId)).toBe(1);
  });
});

describe('snapshots and replay', () => {
  it(`stores a snapshot every ${SNAPSHOT_EVERY} revisions and replays exactly`, () => {
    // paste commits never coalesce (only typing amends the tip), so each
    // loop iteration is its own revision as the cadence check requires
    const expected: string[] = [''];
    for (let i = 1; i <= SNAPSHOT_EVERY + 7; i++) {
      const text = expected[i - 1] + `line ${i}\n`;
      ctx.revisions.commit(docId, [typing(`line ${i}\n`, expected[i - 1].length)], {
        actor: 'user',
        source: { kind: 'paste' },
      });
      expected.push(text);
    }
    const snapshots = ctx.db
      .prepare(
        'SELECT seq FROM revisions WHERE document_id = ? AND snapshot_text IS NOT NULL',
      )
      .all(docId) as Array<{ seq: number }>;
    expect(snapshots.map((s) => s.seq)).toEqual([SNAPSHOT_EVERY]);

    for (const seq of [1, 5, SNAPSHOT_EVERY - 1, SNAPSHOT_EVERY, SNAPSHOT_EVERY + 1, SNAPSHOT_EVERY + 7]) {
      expect(ctx.revisions.getTextAt(docId, seq)).toBe(expected[seq]);
    }
  });

  it('replays edits scattered across the document', () => {
    // paste sources keep the three edits in separate revisions
    ctx.revisions.commit(docId, [typing('the quick brown fox', 0)], {
      actor: 'user',
      source: { kind: 'paste' },
    });
    ctx.revisions.commit(
      docId,
      [{ from: 4, to: 9, deletedText: 'quick', insertedText: 'slow' }],
      { actor: 'user', source: { kind: 'paste' } },
    );
    ctx.revisions.commit(
      docId,
      [{ from: 0, to: 3, deletedText: 'the', insertedText: 'The' }],
      { actor: 'user', source: { kind: 'paste' } },
    );
    expect(readFile()).toBe('The slow brown fox');
    expect(ctx.revisions.getTextAt(docId, 1)).toBe('the quick brown fox');
    expect(ctx.revisions.getTextAt(docId, 2)).toBe('the slow brown fox');
    expect(ctx.revisions.getTextAt(docId, 3)).toBe('The slow brown fox');
  });
});

describe('restore (append-only)', () => {
  it('restores old content as a NEW revision and keeps history intact', () => {
    ctx.revisions.commit(docId, [typing('version one', 0)], {
      actor: 'user',
      source: { kind: 'typing' },
    });
    // paste keeps 'version two' out of the typing tip's coalescing run
    ctx.revisions.commit(
      docId,
      [{ from: 0, to: 11, deletedText: 'version one', insertedText: 'version two' }],
      { actor: 'user', source: { kind: 'paste' } },
    );

    const newSeq = ctx.revisions.restore(docId, 1);
    expect(newSeq).toBe(3);
    expect(readFile()).toBe('version one');
    // history is append-only: earlier revisions still reconstruct
    expect(ctx.revisions.getTextAt(docId, 2)).toBe('version two');

    const revisions = ctx.revisions.listRevisions(docId);
    const restoreRev = revisions.find((r) => r.seq === 3);
    expect(restoreRev?.actor).toBe('user');
    expect(restoreRev?.source).toMatchObject({ kind: 'restore', fromRevision: 1 });
  });
});

describe('external-change import', () => {
  it('imports a changed file as an external revision without rewriting it', () => {
    ctx.revisions.commit(docId, [typing('original', 0)], {
      actor: 'user',
      source: { kind: 'typing' },
    });
    fs.writeFileSync(docPath, 'externally rewritten');

    const result = ctx.revisions.importExternalChange(docId);
    expect(result).toEqual({ kind: 'imported', seq: 2 });
    expect(readFile()).toBe('externally rewritten');
    expect(ctx.revisions.getTextAt(docId, 2)).toBe('externally rewritten');

    const rev = ctx.revisions.listRevisions(docId).find((r) => r.seq === 2);
    expect(rev?.actor).toBe('external');
  });

  it('reports unchanged when the file matches the last revision', () => {
    ctx.revisions.commit(docId, [typing('same', 0)], {
      actor: 'user',
      source: { kind: 'typing' },
    });
    expect(ctx.revisions.importExternalChange(docId)).toEqual({ kind: 'unchanged' });
  });

  it('never overwrites during an in-flight commit — conflict keeps both sides', () => {
    ctx.revisions.commit(docId, [typing('ours', 0)], {
      actor: 'user',
      source: { kind: 'typing' },
    });
    fs.writeFileSync(docPath, 'theirs');

    const conflict = ctx.revisions.importExternalChange(docId, { commitInFlight: true });
    expect(conflict).toEqual({ kind: 'conflict', currentRevision: 1 });
    // nothing imported, DB still at revision 1, file keeps the external edit
    expect(ctx.revisions.getCurrentRevision(docId)).toBe(1);
    expect(readFile()).toBe('theirs');

    // once no commit is in flight, the same import succeeds
    const imported = ctx.revisions.importExternalChange(docId);
    expect(imported).toEqual({ kind: 'imported', seq: 2 });
  });
});

describe('tip amend (revision coalescing)', () => {
  function commitTyping(text: string, at: number, deletedText = ''): number {
    return ctx.revisions.commit(
      docId,
      [{ from: at, to: at + deletedText.length, deletedText, insertedText: text }],
      { actor: 'user', source: { kind: 'typing' } },
    );
  }

  function changeRows(seq: number): number {
    return (
      ctx.db
        .prepare('SELECT COUNT(*) AS n FROM revision_changes WHERE document_id = ? AND seq = ?')
        .get(docId, seq) as { n: number }
    ).n;
  }

  it('amends a recent user-typing tip instead of appending', () => {
    expect(commitTyping('hello', 0)).toBe(1);
    expect(commitTyping(' world', 5)).toBe(1); // same revision
    expect(readFile()).toBe('hello world');
    expect(ctx.revisions.getCurrentRevision(docId)).toBe(1);
    // change rows appended inside the tip revision, replay stays exact
    expect(changeRows(1)).toBe(2);
    expect(ctx.revisions.getTextAt(docId, 1)).toBe('hello world');
    // summary aggregates the whole sitting
    const tip = ctx.revisions.listRevisions(docId)[0];
    expect(tip.summary).toBe('+11 / −0 chars in 2 change(s)');
    // content hash tracks the file (the watcher must not see an external edit)
    const doc = ctx.db
      .prepare('SELECT content_hash FROM documents WHERE id = ?')
      .get(docId) as { content_hash: string };
    expect(tip.contentHash).toBe(doc.content_hash);
  });

  it('starts a new revision when the tip is older than the amend window', () => {
    commitTyping('hello', 0);
    ctx.db
      .prepare('UPDATE revisions SET created_at = ? WHERE document_id = ? AND seq = 1')
      .run(new Date(Date.now() - TIP_AMEND_WINDOW_MS - 1000).toISOString(), docId);
    expect(commitTyping(' world', 5)).toBe(2);
    expect(ctx.revisions.getTextAt(docId, 1)).toBe('hello');
    expect(ctx.revisions.getTextAt(docId, 2)).toBe('hello world');
  });

  it('starts a new revision when the tip is checkpointed', () => {
    commitTyping('hello', 0);
    new CheckpointService(ctx.db, ctx.revisions).create(docId, 'draft');
    expect(commitTyping(' world', 5)).toBe(2);
  });

  it('starts a new revision when the tip is the base of a proposed patch', () => {
    commitTyping('the quick fox', 0);
    const patches = new PatchService(ctx.db, ctx.revisions);
    const result = patches.propose({
      documentId: docId,
      baseRevision: 1,
      title: 't',
      summary: 's',
      groups: [
        { explanation: 'g', changes: [{ from: 4, to: 9, expectedText: 'quick', insert: 'slow' }] },
      ],
    });
    expect(result).toHaveProperty('patchId');
    expect(commitTyping('!', 13)).toBe(2); // patch base must not move
  });

  it('starts a new revision across actor and kind boundaries', () => {
    commitTyping('hello', 0);
    // agent-kind commit breaks the run
    ctx.revisions.commit(docId, [{ from: 5, to: 5, deletedText: '', insertedText: '!' }], {
      actor: 'agent',
      source: { kind: 'patch', patchId: 'p1' },
    });
    expect(commitTyping('?', 6)).toBe(3); // tip is agent/patch — no amend
    // paste commits never coalesce
    ctx.revisions.commit(docId, [{ from: 7, to: 7, deletedText: '', insertedText: 'P' }], {
      actor: 'user',
      source: { kind: 'paste' },
    });
    expect(commitTyping('~', 8)).toBe(5); // tip is user/paste — no amend
  });

  it('refreshes the snapshot when the amended tip has one', () => {
    // 24 paste revisions + 1 typing revision at seq SNAPSHOT_EVERY → the tip
    // is user/typing AND carries a snapshot
    for (let i = 1; i < SNAPSHOT_EVERY; i++) {
      ctx.revisions.commit(
        docId,
        [{ from: i - 1, to: i - 1, deletedText: '', insertedText: 'x' }],
        { actor: 'user', source: { kind: 'paste' } },
      );
    }
    ctx.revisions.commit(
      docId,
      [{ from: 24, to: 24, deletedText: '', insertedText: 'y' }],
      { actor: 'user', source: { kind: 'typing' } },
    );
    expect(ctx.revisions.getCurrentRevision(docId)).toBe(SNAPSHOT_EVERY);
    expect(commitTyping('z', 25)).toBe(SNAPSHOT_EVERY); // amended
    const text = 'x'.repeat(24) + 'yz';
    expect(readFile()).toBe(text);
    expect(ctx.revisions.getTextAt(docId, SNAPSHOT_EVERY)).toBe(text);
    const row = ctx.db
      .prepare('SELECT snapshot_text FROM revisions WHERE document_id = ? AND seq = ?')
      .get(docId, SNAPSHOT_EVERY) as { snapshot_text: string | null };
    expect(row.snapshot_text).toBe(text);
  });
});
