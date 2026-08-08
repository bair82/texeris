import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ContextManifest } from '../../shared/chat-types';
import { CheckpointService } from './checkpoint';
import { ConversationService } from './conversation';
import { PatchService } from './patch';
import { createProject, ensureDocument, type ProjectContext } from './project';
import { RewindService } from './rewind';

let root: string;
let ctx: ProjectContext;
let conversations: ConversationService;
let checkpoints: CheckpointService;
let patches: PatchService;
let rewind: RewindService;
let docId: string;
let docPath: string;
let conversationId: string;

function manifestFor(documentId: string, baseRevision: number): ContextManifest {
  return {
    scope: { kind: 'document' },
    documentId,
    items: [{ label: 'manuscript.md (document)', chars: 10 }],
    baseRevision,
    truncated: false,
    notices: [],
  };
}

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: Date.now() };
}

function assistantMessage(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'faux',
    model: 'faux-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

function type(text: string, at: number): void {
  ctx.revisions.commit(docId, [{ from: at, to: at, deletedText: '', insertedText: text }], {
    actor: 'user',
    source: { kind: 'typing' },
  });
}

/** Two completed turns with recorded boundaries; the document gains a
 * revision between them. Returns [runId1, runId2]. */
function seedTwoTurns(): [string, string] {
  type('chapter one', 0); // rev 1
  conversationId = conversations.getOrCreateConversation();

  const run1 = conversations.startRun({
    conversationId,
    modelMode: 'fast',
    provider: 'faux',
    model: 'faux-model',
    manifest: manifestFor(docId, 1),
  });
  conversations.appendMessages(conversationId, [
    userMessage('improve the intro'),
    assistantMessage('done with the intro'),
  ]);
  conversations.finishRun(run1, { status: 'completed', endMessageSeq: 2, endRevision: 1 });

  ctx.revisions.commit(
    docId,
    [{ from: 'chapter one'.length, to: 'chapter one'.length, deletedText: '', insertedText: ' — expanded' }],
    { actor: 'user', source: { kind: 'paste' } },
  ); // rev 2 (paste kind — typing would amend the tip)

  const run2 = conversations.startRun({
    conversationId,
    modelMode: 'fast',
    provider: 'faux',
    model: 'faux-model',
    manifest: manifestFor(docId, 2),
  });
  conversations.appendMessages(conversationId, [
    userMessage('now the conclusion'),
    assistantMessage('conclusion done'),
  ]);
  conversations.finishRun(run2, { status: 'completed', endMessageSeq: 4, endRevision: 2 });
  return [run1, run2];
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-rewind-'));
  ctx = createProject(root);
  conversations = new ConversationService(ctx.db);
  checkpoints = new CheckpointService(ctx.db, ctx.revisions);
  patches = new PatchService(ctx.db, ctx.revisions);
  rewind = new RewindService(ctx.db, conversations, ctx.revisions, checkpoints, patches);
  docId = ensureDocument(ctx, 'manuscript.md');
  docPath = path.join(root, 'manuscript.md');
});

afterEach(() => {
  ctx.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('RewindService.listPoints', () => {
  it('lists completed turns with descriptions from their user message', () => {
    seedTwoTurns();
    const points = rewind.listPoints(conversationId, docId);
    expect(points).toHaveLength(2);
    // newest first
    expect(points[0].boundarySeq).toBe(4);
    expect(points[1].boundarySeq).toBe(2);
    expect(points[1].description).toBe('improve the intro');
    expect(points[0].targetRevision).toBe(2);
    expect(points[1].targetRevision).toBe(1);
    expect(points.every((p) => p.kind === 'turn' && p.documentId === docId)).toBe(true);
  });

  it('includes checkpoints of the given document with their description', () => {
    type('chapter one', 0);
    checkpoints.create(docId, 'first draft', 'before agent edits');
    const points = rewind.listPoints(conversationId ?? 'none', docId);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      kind: 'checkpoint',
      description: 'first draft — before agent edits',
      targetRevision: 1,
    });
  });

  it('skips runs without a recorded boundary or document context', () => {
    seedTwoTurns();
    // legacy run: no boundary columns
    const legacy = conversations.startRun({
      conversationId,
      modelMode: 'fast',
      provider: 'faux',
      model: 'faux-model',
      manifest: manifestFor(docId, 2),
    });
    conversations.finishRun(legacy, { status: 'completed' });
    // run without document context (legacy/foreign manifest shape)
    ctx.db
      .prepare(
        `INSERT INTO agent_runs
           (id, conversation_id, model_mode, provider, model, status, started_at,
            context_manifest_json, end_message_seq)
         VALUES ('nodoc', ?, 'fast', 'faux', 'faux', 'completed', 'now', '{}', 4)`,
      )
      .run(conversationId);
    const points = rewind.listPoints(conversationId, docId);
    expect(points).toHaveLength(2);
  });
});

describe('RewindService.preview', () => {
  it('returns both texts and pending patches that survive the rewind', () => {
    const [run1] = seedTwoTurns();
    ctx.db
      .prepare(
        `INSERT INTO patches (id, document_id, base_revision, origin_json, title, summary, status, created_at)
         VALUES ('p1', ?, 2, '{}', 'tighten intro', '', 'proposed', 'now')`,
      )
      .run(docId);
    ctx.db
      .prepare(
        `INSERT INTO patches (id, document_id, base_revision, origin_json, title, summary, status, created_at)
         VALUES ('p2', ?, 1, '{}', 'old accepted', '', 'accepted', 'now')`,
      )
      .run(docId);

    const preview = rewind.preview(conversationId, 'turn', run1);
    expect(preview.point.boundarySeq).toBe(2);
    expect(preview.currentRevision).toBe(2);
    expect(preview.currentText).toBe('chapter one — expanded');
    expect(preview.targetText).toBe('chapter one');
    // only unresolved patches are surfaced — evidence is never silently dropped
    expect(preview.pendingPatches).toEqual([
      { id: 'p1', title: 'tighten intro', status: 'proposed' },
    ]);
  });
});

describe('RewindService.apply', () => {
  it('restores the document as a new revision and forks the conversation', () => {
    const [run1] = seedTwoTurns();
    expect(fs.readFileSync(docPath, 'utf8')).toBe('chapter one — expanded');

    const result = rewind.apply(conversationId, 'turn', run1);
    expect(result.revisionSeq).toBe(3);
    expect(result.conversationId).toBeDefined();
    expect(fs.readFileSync(docPath, 'utf8')).toBe('chapter one');

    // restore is append-only: the pre-rewind state stays in history
    expect(ctx.revisions.getTextAt(docId, 2)).toBe('chapter one — expanded');

    // the fork holds only messages up to the boundary, verbatim
    const forkId = result.conversationId as string;
    const forkMessages = conversations.listUiMessages(forkId);
    expect(forkMessages.map((m) => m.seq)).toEqual([1, 2]);
    expect(forkMessages[0].text).toBe('improve the intro');
    // the original conversation is untouched
    expect(conversations.listUiMessages(conversationId)).toHaveLength(4);
    expect(conversations.listRuns(conversationId)).toHaveLength(2);
    // fork title marks the provenance
    const fork = conversations.listConversations().find((c) => c.id === forkId);
    expect(fork?.title.endsWith('(rewind)')).toBe(true);
    // the forked run history contains only the turn inside the boundary
    expect(conversations.listRuns(forkId)).toHaveLength(1);
  });

  it('restores a checkpoint without forking the conversation', () => {
    type('v1 text', 0);
    const cp = checkpoints.create(docId, 'v1');
    type(' plus more', 'v1 text'.length);
    conversationId = conversations.getOrCreateConversation();

    const result = rewind.apply(conversationId, 'checkpoint', cp.id);
    expect(result.conversationId).toBeUndefined();
    expect(fs.readFileSync(docPath, 'utf8')).toBe('v1 text');
  });

  it('rejects a turn from another conversation', () => {
    const [run1] = seedTwoTurns();
    const other = conversations.startNewConversation();
    expect(() => rewind.preview(other, 'turn', run1)).toThrow(/unknown rewind turn/);
  });
});
