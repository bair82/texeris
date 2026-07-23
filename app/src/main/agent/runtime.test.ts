import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createModels } from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxProviderHandle,
  type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux';
import { PiAgentRuntime } from './runtime';
import { ConversationService } from '../services/conversation';
import { PatchService } from '../services/patch';
import { createProject, ensureDocument, type ProjectContext } from '../services/project';
import type { NormalizedAgentEvent } from '../../shared/chat-types';

let root: string;
let ctx: ProjectContext;
let conversations: ConversationService;
let patches: PatchService;
let faux: FauxProviderHandle;
let runtime: PiAgentRuntime;
let conversationId: string;

const CONFIG = {
  modes: {
    fast: { provider: 'faux', model: 'faux-model' },
    deep: { provider: 'faux', model: 'faux-model' },
  },
  spellcheck: { enabled: false, language: 'en-US' },
  appearance: {
    theme: 'dark' as const,
    fontFamily: 'serif' as const,
    fontSize: 16.5,
    editorWidth: 'comfortable' as const,
  },
  patchStyleMode: 'off' as const,
  activeProfileId: null,
};

function makeRuntime(): PiAgentRuntime {
  const models = createModels();
  models.setProvider(faux.provider);
  return new PiAgentRuntime({ models, config: CONFIG, conversations, project: ctx, patches });
}

async function drain(runId: string): Promise<NormalizedAgentEvent[]> {
  const events: NormalizedAgentEvent[] = [];
  for await (const event of runtime.events(runId)) {
    events.push(event);
  }
  return events;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-rt-'));
  ctx = createProject(root);
  const docId = ensureDocument(ctx, 'manuscript.md');
  ctx.revisions.commit(
    docId,
    [{ from: 0, to: 0, deletedText: '', insertedText: '# Notes\n\nThe quick brown fox.\n' }],
    { actor: 'user', source: { kind: 'typing' } },
  );
  conversations = new ConversationService(ctx.db);
  patches = new PatchService(ctx.db, ctx.revisions);
  faux = fauxProvider({ models: [{ id: 'faux-model' }] });
  runtime = makeRuntime();
  conversationId = conversations.getOrCreateConversation();
});

afterEach(() => {
  ctx.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('PiAgentRuntime', () => {
  it('streams an answer end-to-end and persists the turn', async () => {
    faux.setResponses([fauxAssistantMessage('The fox is quick.')]);
    const { runId } = await runtime.startTurn({
      conversationId,
      text: 'How quick is the fox?',
      mode: 'fast',
      scope: { kind: 'document' },
    });
    const events = await drain(runId);

    expect(events[0]).toEqual({ type: 'run_start', runId, mode: 'fast' });
    const deltas = events.filter((e) => e.type === 'text_delta');
    expect(deltas.map((d) => d.delta).join('')).toBe('The fox is quick.');
    const end = events.at(-1);
    expect(end).toMatchObject({ type: 'run_end', status: 'completed' });
    expect(end).toMatchObject({ manifest: { baseRevision: 1 } });

    // persisted: user + assistant, replayable verbatim
    const stored = conversations.listAgentMessages(conversationId);
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(conversations.listUiMessages(conversationId).at(-1)?.text).toBe(
      'The fox is quick.',
    );

    // run recorded with usage
    const runs = conversations.listRuns(conversationId);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('completed');
    expect(runs[0].provider).toBe('faux');
  });

  it('executes read-only tools and records tool events', async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('read_document', {})]),
      fauxAssistantMessage('I read the document.'),
    ]);
    const { runId } = await runtime.startTurn({
      conversationId,
      text: 'Read my document.',
      mode: 'fast',
      scope: { kind: 'document' },
    });
    const events = await drain(runId);

    const toolStart = events.find((e) => e.type === 'tool_start');
    const toolEnd = events.find((e) => e.type === 'tool_end');
    expect(toolStart).toMatchObject({ toolName: 'read_document' });
    expect(toolEnd).toMatchObject({ toolName: 'read_document', isError: false });
    expect(events.at(-1)).toMatchObject({ status: 'completed' });

    const roles = conversations.listAgentMessages(conversationId).map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'toolResult', 'assistant']);
    const toolResult = conversations.listUiMessages(conversationId).find((m) => m.role === 'tool');
    expect(toolResult?.text).toContain('The quick brown fox.');
    expect(faux.state.callCount).toBe(2);
  });

  it('replays stored history into a fresh runtime (restart survival)', async () => {
    faux.setResponses([fauxAssistantMessage('first answer')]);
    const first = await runtime.startTurn({
      conversationId,
      text: 'first question',
      mode: 'fast',
      scope: { kind: 'document' },
    });
    await drain(first.runId);

    // simulate an app restart: new runtime over the same DB
    runtime = makeRuntime();
    let seenMessageCount = 0;
    const capture: FauxResponseStep = (context) => {
      seenMessageCount = context.messages.length;
      return fauxAssistantMessage('second answer');
    };
    faux.setResponses([capture]);
    const second = await runtime.startTurn({
      conversationId,
      text: 'second question',
      mode: 'fast',
      scope: { kind: 'document' },
    });
    await drain(second.runId);

    // model saw: prior user+assistant + the new user message
    expect(seenMessageCount).toBe(3);
    expect(conversations.listAgentMessages(conversationId)).toHaveLength(4);
  });

  it('cancel aborts the stream mid-run and records it', async () => {
    const slow = fauxProvider({
      models: [{ id: 'faux-model' }],
      tokensPerSecond: 5,
      tokenSize: { min: 5, max: 5 },
    });
    const models = createModels();
    models.setProvider(slow.provider);
    runtime = new PiAgentRuntime({ models, config: CONFIG, conversations, project: ctx, patches });
    slow.setResponses([
      fauxAssistantMessage(
        'a fairly long answer that takes a while to stream token by token',
      ),
    ]);

    const { runId } = await runtime.startTurn({
      conversationId,
      text: 'say a lot',
      mode: 'fast',
      scope: { kind: 'document' },
    });
    const eventsPromise = drain(runId);
    await runtime.cancel(runId);
    const events = await eventsPromise;

    expect(events.at(-1)).toMatchObject({ type: 'run_end', status: 'aborted' });
    expect(conversations.listRuns(conversationId)[0].status).toBe('aborted');
  });

  it('propose_patch stores the patch with the run origin', async () => {
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('propose_patch', {
          baseRevision: 1,
          title: 'Slow the fox',
          summary: 'quick → slow',
          groups: [
            {
              explanation: 'adjective',
              changes: [{ from: 13, to: 18, expectedText: 'quick', insert: 'slow' }],
            },
          ],
        }),
      ]),
      fauxAssistantMessage('I proposed a patch; please review it.'),
    ]);
    const { runId } = await runtime.startTurn({
      conversationId,
      text: 'make the fox slower',
      mode: 'fast',
      scope: { kind: 'document' },
    });
    const events = await drain(runId);
    expect(events.find((e) => e.type === 'tool_start')).toMatchObject({
      toolName: 'propose_patch',
    });
    const proposed = patches.list();
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({ title: 'Slow the fox', status: 'proposed' });
    // origin links patch → conversation + run
    const origin = ctx.db
      .prepare('SELECT origin_json FROM patches WHERE id = ?')
      .get(proposed[0].id) as { origin_json: string };
    expect(JSON.parse(origin.origin_json)).toEqual({ conversationId, agentRunId: runId });

    // acceptance records the agent revision linked to the patch
    const accepted = patches.accept(proposed[0].id);
    expect(accepted).toHaveProperty('seq');
    const docId = ensureDocument(ctx, 'manuscript.md');
    expect(ctx.revisions.getCurrentText(docId)).toContain('slow brown fox');
    const agentRev = ctx.revisions
      .listRevisions(docId)
      .find((r) => r.actor === 'agent');
    expect(agentRev?.source).toMatchObject({ kind: 'patch', patchId: proposed[0].id });
  });

  it('injects a compact change summary between turns (last-seen revision)', async () => {
    const seenPrompts: string[] = [];
    faux.setResponses([
      (context) => {
        seenPrompts.push(context.systemPrompt ?? '');
        return fauxAssistantMessage('first answer');
      },
      (context) => {
        seenPrompts.push(context.systemPrompt ?? '');
        return fauxAssistantMessage('second answer');
      },
    ]);

    const first = await runtime.startTurn({
      conversationId,
      text: 'first question',
      mode: 'fast',
      scope: { kind: 'document' },
    });
    await drain(first.runId);

    // user edits between turns: quick → slow (revision coalescing amends
    // the tip: still rev 1, but with new change rows)
    const docId = ensureDocument(ctx, 'manuscript.md');
    ctx.revisions.commit(
      docId,
      [{ from: 13, to: 18, deletedText: 'quick', insertedText: 'slow' }],
      { actor: 'user', source: { kind: 'typing' } },
    );

    const second = await runtime.startTurn({
      conversationId,
      text: 'second question',
      mode: 'fast',
      scope: { kind: 'document' },
    });
    await drain(second.runId);

    expect(seenPrompts).toHaveLength(2);
    // first turn: no previous run → no recent-changes section
    expect(seenPrompts[0]).not.toContain('<recent-changes');
    // second turn: compact diff of what changed since the agent last looked
    // (anchored by change index — the revision number did not move)
    expect(seenPrompts[1]).toContain('<recent-changes since-revision="1" current-revision="1">');
    expect(seenPrompts[1]).toContain('+"slow"');
  });

  it('rejects a second turn in any conversation while one is running', async () => {
    const slow = fauxProvider({ models: [{ id: 'faux-model' }], tokensPerSecond: 1 });
    const models = createModels();
    models.setProvider(slow.provider);
    runtime = new PiAgentRuntime({ models, config: CONFIG, conversations, project: ctx, patches });
    slow.setResponses([fauxAssistantMessage('slow answer that keeps streaming along')]);

    const first = await runtime.startTurn({
      conversationId,
      text: 'one',
      mode: 'fast',
      scope: { kind: 'document' },
    });
    const otherConversationId = conversations.startNewConversation();
    await expect(
      runtime.startTurn({
        conversationId: otherConversationId,
        text: 'two',
        mode: 'fast',
        scope: { kind: 'document' },
      }),
    ).rejects.toThrow(/another turn is already in progress/);
    await runtime.cancel(first.runId);
    await drain(first.runId);
  });

  it('aborts and detaches an active run before its conversation is deleted', async () => {
    const slow = fauxProvider({ models: [{ id: 'faux-model' }], tokensPerSecond: 1 });
    const models = createModels();
    models.setProvider(slow.provider);
    runtime = new PiAgentRuntime({ models, config: CONFIG, conversations, project: ctx, patches });
    slow.setResponses([fauxAssistantMessage('slow answer that keeps streaming along')]);

    const { runId } = await runtime.startTurn({
      conversationId,
      text: 'one',
      mode: 'fast',
      scope: { kind: 'document' },
    });
    const eventsPromise = drain(runId);
    runtime.cancelConversation(conversationId);
    const events = await eventsPromise;

    expect(events.at(-1)).toMatchObject({ type: 'run_end', status: 'aborted', errorMessage: 'conversation deleted' });
    expect(conversations.listRuns(conversationId)[0]).toMatchObject({ status: 'aborted', error: 'conversation deleted' });
  });

  it('detaches an active run before swapping projects', async () => {
    const slow = fauxProvider({ models: [{ id: 'faux-model' }], tokensPerSecond: 1 });
    const models = createModels();
    models.setProvider(slow.provider);
    runtime = new PiAgentRuntime({ models, config: CONFIG, conversations, project: ctx, patches });
    slow.setResponses([fauxAssistantMessage('slow answer that keeps streaming along')]);

    const { runId } = await runtime.startTurn({
      conversationId,
      text: 'one',
      mode: 'fast',
      scope: { kind: 'document' },
    });
    const eventsPromise = drain(runId);
    const next = createProject(path.join(root, 'next-project'));
    const nextConversations = new ConversationService(next.db);
    const nextPatches = new PatchService(next.db, next.revisions);
    runtime.setProject(next, nextConversations, nextPatches);
    const events = await eventsPromise;

    expect(events.at(-1)).toMatchObject({ type: 'run_end', status: 'aborted', errorMessage: 'project switched' });
    expect(conversations.listRuns(conversationId)[0]).toMatchObject({ status: 'aborted', error: 'project switched' });
    expect(nextConversations.listConversations()).toHaveLength(0);
    next.db.close();
  });
});
