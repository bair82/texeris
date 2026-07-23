import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { ConversationService } from './conversation';
import { createProject, type ProjectContext } from './project';

let root: string;
let ctx: ProjectContext;
let conversations: ConversationService;

const manifest = {
  scope: { kind: 'document' as const },
  documentId: 'doc-1',
  items: [{ label: 'manuscript.md (document)', chars: 10 }],
  baseRevision: 1,
  truncated: false,
  notices: [],
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-conv-'));
  ctx = createProject(root);
  conversations = new ConversationService(ctx.db);
});

afterEach(() => {
  ctx.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: Date.now() };
}

describe('ConversationService', () => {
  it('returns the same conversation on repeated calls; startNew rotates it', () => {
    const a = conversations.getOrCreateConversation();
    const b = conversations.getOrCreateConversation();
    expect(a).toBe(b);
    const c = conversations.startNewConversation();
    expect(c).not.toBe(a);
    expect(conversations.getOrCreateConversation()).toBe(c);
  });

  it('round-trips messages verbatim for replay and derives UI messages', () => {
    const id = conversations.getOrCreateConversation();
    const messages: AgentMessage[] = [
      userMessage('hello'),
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi there' }],
        api: 'openai-completions',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
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
      },
    ];
    conversations.appendMessages(id, messages);

    const replayed = conversations.listAgentMessages(id);
    expect(replayed).toEqual(messages);

    const ui = conversations.listUiMessages(id);
    expect(ui).toEqual([
      { seq: 1, role: 'user', text: 'hello' },
      { seq: 2, role: 'assistant', text: 'hi there' },
    ]);
  });

  it('records agent runs with status, usage and manifest', () => {
    const id = conversations.getOrCreateConversation();
    const runId = conversations.startRun({
      conversationId: id,
      modelMode: 'fast',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      manifest,
    });
    conversations.finishRun(runId, {
      status: 'completed',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    });
    const runs = conversations.listRuns(id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: runId,
      status: 'completed',
      provider: 'deepseek',
      modelMode: 'fast',
    });
    expect(runs[0].usage?.output).toBe(5);
    expect(runs[0].manifest?.baseRevision).toBe(1);
    expect(runs[0].endedAt).toBeTruthy();
  });
});

describe('conversation management (EU3)', () => {
  it('lists conversations newest-first with message counts', () => {
    const a = conversations.startNewConversation();
    conversations.appendMessages(a, [userMessage('first question')]);
    const b = conversations.startNewConversation();
    conversations.appendMessages(b, [userMessage('second'), userMessage('follow-up')]);
    const list = conversations.listConversations();
    expect(list.map((c) => c.id)).toEqual([b, a]);
    expect(list[0].messageCount).toBe(2);
    expect(list[1].messageCount).toBe(1);
  });

  it('auto-titles from the first user message while the default stands', () => {
    const id = conversations.startNewConversation();
    conversations.appendMessages(id, [
      userMessage('can you tighten the introduction of my attention paper?'),
    ]);
    const [conv] = conversations.listConversations();
    expect(conv.title).toBe('can you tighten the introduction of my attention…');
    // renamed conversations keep their title
    conversations.renameConversation(id, 'intro work');
    conversations.appendMessages(id, [userMessage('another question')]);
    expect(conversations.listConversations()[0].title).toBe('intro work');
  });

  it('renames and rejects empty titles', () => {
    const id = conversations.startNewConversation();
    conversations.renameConversation(id, 'methodology');
    expect(conversations.listConversations()[0].title).toBe('methodology');
    expect(() => conversations.renameConversation(id, '   ')).toThrow(/empty/);
  });

  it('deletes a conversation with its messages and runs', () => {
    const id = conversations.startNewConversation();
    conversations.appendMessages(id, [userMessage('hello')]);
    conversations.startRun({
      conversationId: id,
      modelMode: 'fast',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      manifest,
    });
    conversations.deleteConversation(id);
    expect(conversations.listConversations()).toHaveLength(0);
    expect(conversations.listUiMessages(id)).toHaveLength(0);
    expect(conversations.listRuns(id)).toHaveLength(0);
  });

  it('deletes profile grants, sources, and delegated results with their conversation', () => {
    const id = conversations.startNewConversation({ id: 'writing-profile', version: 1 });
    const grantId = 'grant-1';
    ctx.db.prepare(
      'INSERT INTO corpus_grants (id, conversation_id, created_at, source_kind) VALUES (?, ?, ?, ?)',
    ).run(grantId, id, '2026-07-22T00:00:00.000Z', 'files');
    ctx.db.prepare(
      `INSERT INTO corpus_sources
       (id, grant_id, original_path, canonical_path, source_hash, source_size,
        source_mtime, format, markdown_path, markdown_hash, converter,
        conversion_warnings_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? )`,
    ).run(
      'source-1', grantId, '/tmp/original.md', '/tmp/original.md', 'source-hash', 1,
      '2026-07-22T00:00:00.000Z', 'md', '/tmp/derivative.md', 'markdown-hash', 'none', '[]',
    );
    ctx.db.prepare(
      `INSERT INTO delegated_results
       (id, parent_run_id, conversation_id, role_id, status, task, provider, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('delegation-1', 'run-1', id, 'corpus-analyst', 'completed', 'summarize', 'faux', 'faux-model', '2026-07-22T00:00:00.000Z');

    conversations.deleteConversation(id);

    for (const table of ['conversations', 'corpus_grants', 'corpus_sources', 'delegated_results']) {
      const count = (ctx.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
      expect(count, table).toBe(0);
    }
  });
});
