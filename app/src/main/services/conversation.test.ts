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
