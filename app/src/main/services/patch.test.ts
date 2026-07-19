import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProposePatchInput } from '../../shared/patch-types';
import { PatchService } from './patch';
import { createProject, ensureDocument, type ProjectContext } from './project';

let root: string;
let ctx: ProjectContext;
let patches: PatchService;
let docId: string;
let docPath: string;

const TEXT = '# Paper\n\nThe quick brown fox jumps.\n\nSecond paragraph here.\n';
// offsets: "quick" at 13..18, "Second" at 37..43

function input(groups: ProposePatchInput['groups'], baseRevision = 1): ProposePatchInput {
  return { baseRevision, title: 'Test patch', summary: 'summary', groups };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-patch-'));
  ctx = createProject(root);
  patches = new PatchService(ctx.db, ctx.revisions);
  docId = ensureDocument(ctx, 'manuscript.md');
  docPath = path.join(root, 'manuscript.md');
  ctx.revisions.commit(docId, [{ from: 0, to: 0, deletedText: '', insertedText: TEXT }], {
    actor: 'user',
    source: { kind: 'typing' },
  });
});

afterEach(() => {
  ctx.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('PatchService.propose', () => {
  it('stores a valid patch as proposed with groups and changes', () => {
    const result = patches.propose(
      {
        ...input([
          {
            explanation: 'fix adjective',
            changes: [{ from: 13, to: 18, expectedText: 'quick', insert: 'slow' }],
          },
        ]),
        documentId: docId,
      },
      { conversationId: 'c1', agentRunId: 'r1' },
    );
    expect(result).toHaveProperty('patchId');
    const { patchId } = result as { patchId: string };
    const record = patches.get(patchId)!;
    expect(record.status).toBe('proposed');
    expect(record.groups).toHaveLength(1);
    expect(record.groups[0].explanation).toBe('fix adjective');
    expect(record.groups[0].changes[0]).toMatchObject({ from: 13, expectedText: 'quick' });
  });

  it('rejects a bad anchor with a structured conflict, storing nothing', () => {
    const result = patches.propose(
      {
        ...input([
          {
            explanation: 'wrong',
            changes: [{ from: 13, to: 18, expectedText: 'QUICK', insert: 'slow' }],
          },
        ]),
        documentId: docId,
      },
    );
    expect(result).toHaveProperty('conflict');
    expect((result as { conflict: unknown[] }).conflict).toHaveLength(1);
    expect(patches.list(docId)).toHaveLength(0);
  });

  it('rejects an out-of-range base revision', () => {
    const result = patches.propose(
      { ...input([{ explanation: 'x', changes: [{ from: 13, to: 18, expectedText: 'quick', insert: 'slow' }] }], 99), documentId: docId },
    );
    expect(result).toHaveProperty('conflict');
    expect((result as { conflict: Array<{ reason: string }> }).conflict[0].reason).toBe(
      'base-revision-mismatch',
    );
  });
});

describe('PatchService.accept', () => {
  function proposedPatch(): string {
    const result = patches.propose(
      {
        ...input([
          {
            explanation: 'group one',
            changes: [{ from: 13, to: 18, expectedText: 'quick', insert: 'slow' }],
          },
          {
            explanation: 'group two',
            changes: [{ from: 37, to: 43, expectedText: 'Second', insert: 'Final' }],
          },
        ]),
        documentId: docId,
      },
      { conversationId: 'c1', agentRunId: 'r1' },
    );
    return (result as { patchId: string }).patchId;
  }

  it('applies all groups as one agent revision linked to the patch', () => {
    const patchId = proposedPatch();
    const outcome = patches.accept(patchId);
    expect(outcome).toHaveProperty('seq');
    const { seq, previousSeq } = outcome as { seq: number; previousSeq: number };
    expect(previousSeq).toBe(1);
    expect(seq).toBe(2);
    expect(fs.readFileSync(docPath, 'utf8')).toBe(
      '# Paper\n\nThe slow brown fox jumps.\n\nFinal paragraph here.\n',
    );
    const rev = ctx.revisions.listRevisions(docId).find((r) => r.seq === 2);
    expect(rev?.actor).toBe('agent');
    expect(rev?.source).toMatchObject({ kind: 'patch', patchId, conversationId: 'c1', agentRunId: 'r1' });
    expect(patches.get(patchId)!.status).toBe('accepted');
    // both changes recorded individually
    const changes = ctx.db
      .prepare('SELECT deleted_text, inserted_text FROM revision_changes WHERE document_id = ? AND seq = 2 ORDER BY idx')
      .all(docId) as unknown as Array<{ deleted_text: string; inserted_text: string }>;
    expect(changes).toEqual([
      { deleted_text: 'quick', inserted_text: 'slow' },
      { deleted_text: 'Second', inserted_text: 'Final' },
    ]);
  });

  it('partial accept applies one group; accepting the rest completes it', () => {
    const patchId = proposedPatch();
    const record = patches.get(patchId)!;
    const first = patches.accept(patchId, [record.groups[0].id]);
    expect(first).toHaveProperty('seq');
    expect(fs.readFileSync(docPath, 'utf8')).toContain('slow brown fox');
    expect(fs.readFileSync(docPath, 'utf8')).toContain('Second paragraph');
    expect(patches.get(patchId)!.status).toBe('partial');

    const second = patches.accept(patchId, [record.groups[1].id]);
    expect(second).toHaveProperty('seq');
    expect(fs.readFileSync(docPath, 'utf8')).toContain('Final paragraph');
    expect(patches.get(patchId)!.status).toBe('accepted');
  });

  it('auto-rebases when the document moved but the anchors still match', () => {
    const patchId = proposedPatch();
    // user appends a paragraph — anchors untouched
    ctx.revisions.commit(
      docId,
      [{ from: TEXT.length, to: TEXT.length, deletedText: '', insertedText: '\nNew last paragraph.\n' }],
      { actor: 'user', source: { kind: 'typing' } },
    );
    const outcome = patches.accept(patchId);
    expect(outcome).toHaveProperty('seq');
    expect(fs.readFileSync(docPath, 'utf8')).toContain('slow brown fox');
  });

  it('fails safely with visible conflict when an anchor went stale', () => {
    const patchId = proposedPatch();
    // user rewrites the anchor span itself
    ctx.revisions.commit(
      docId,
      [{ from: 13, to: 18, deletedText: 'quick', insertedText: 'rapid' }],
      { actor: 'user', source: { kind: 'typing' } },
    );
    const outcome = patches.accept(patchId);
    expect(outcome).toHaveProperty('conflict');
    expect(patches.get(patchId)!.status).toBe('conflict');
    // text untouched beyond the user's own edit
    expect(fs.readFileSync(docPath, 'utf8')).toContain('rapid brown fox');
  });
});

describe('PatchService.reject', () => {
  it('rejects all groups → status rejected; mixed → partial', () => {
    const make = () =>
      (patches.propose(
        {
          ...input([
            { explanation: 'a', changes: [{ from: 13, to: 18, expectedText: 'quick', insert: 'slow' }] },
            { explanation: 'b', changes: [{ from: 37, to: 43, expectedText: 'Second', insert: 'Final' }] },
          ]),
          documentId: docId,
        },
      ) as { patchId: string }).patchId;

    const p1 = make();
    patches.reject(p1);
    expect(patches.get(p1)!.status).toBe('rejected');

    const p2 = make();
    const record = patches.get(p2)!;
    patches.accept(p2, [record.groups[0].id]);
    patches.reject(p2, [record.groups[1].id]);
    expect(patches.get(p2)!.status).toBe('partial');
  });
});
