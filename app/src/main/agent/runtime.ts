import {
  Agent,
  type AgentMessage,
} from '@earendil-works/pi-agent-core';
import type { Models } from '@earendil-works/pi-ai';
import type {
  ContextManifest,
  ModelMode,
  NormalizedAgentEvent,
  StartTurnRequest,
  UsageSummary,
} from '../../shared/chat-types';
import type { ConversationService } from '../services/conversation';
import type { PatchService } from '../services/patch';
import type { ProjectContext } from '../services/project';
import type { WorkspaceConfig } from '../services/settings';
import type { ChangeSummary } from './changes';
import { summarizeChangesSince } from './changes';
import { assembleContext, buildSystemPrompt, DOC_BUDGET_CHARS } from './context';
import { createAgentTools } from './tools';
import type { CorpusService } from '../services/corpus';
import { CorpusService as DefaultCorpusService } from '../services/corpus';
import { WritingProfileService } from '../services/profile';
import { AgentCoordinator } from './coordinator';
import { PatchStyleGate } from './styleCritic';
import { skillById } from './skills';
import type { ArchiveService } from '../services/archive';

/**
 * The AgentRuntime adapter (plan §10.1): one Pi Agent per conversation,
 * events normalized onto our union, message-shaped so a later move to a
 * utilityProcess is mechanical. Gotchas honoured (pi-integration-notes):
 * explicit streamFn bound to the Models collection, explicit model, abort
 * via agent.abort(), fast non-blocking subscribers.
 */
export interface AgentRuntime {
  startTurn(input: StartTurnRequest): Promise<{ runId: string }>;
  events(runId: string): AsyncIterable<NormalizedAgentEvent>;
  cancel(runId: string): Promise<void>;
  /** Reject work that would overlap the single foreground run. */
  assertIdle(): void;
  /** Abort and detach a run before its conversation is deleted. */
  cancelConversation(conversationId: string): void;
}

/** Simple async push-queue: producers push/close, consumers iterate. */
class EventQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
    } else {
      this.buffer.push(value);
    }
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length) {
      this.waiters.shift()?.({ value: undefined as T, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const value = this.buffer.shift();
      if (value !== undefined) {
        yield value;
      } else if (this.closed) {
        return;
      } else {
        const result = await new Promise<IteratorResult<T>>((resolve) =>
          this.waiters.push(resolve),
        );
        if (result.done) {
          return;
        }
        yield result.value;
      }
    }
  }
}

interface ActiveRun {
  runId: string;
  conversationId: string;
  mode: ModelMode;
  agent: Agent;
  queue: EventQueue<NormalizedAgentEvent>;
  unsubscribe: () => void;
  manifest: ContextManifest;
}

export class PiAgentRuntime implements AgentRuntime {
  private readonly agents = new Map<string, Agent>();
  private readonly runs = new Map<string, ActiveRun>();
  /** Run context handed to tools (patch origin) while a run is active. */
  private activeRunContext: { conversationId: string; runId: string; documentId: string; task: string; skillId?: string } | null = null;
  private coordinator: AgentCoordinator;
  private styleGate: PatchStyleGate;
  private corpus: CorpusService;
  private profiles: WritingProfileService;
  private archive: Pick<ArchiveService, 'passages'>;

  constructor(
    private readonly options: {
      models: Models;
      config: WorkspaceConfig;
      conversations: ConversationService;
      project: ProjectContext;
      patches: PatchService;
      corpus?: CorpusService;
      profiles?: WritingProfileService;
      archive?: ArchiveService;
      /** Per-provider key lookup (stored keychain key wins over env). */
      credentials?: { getApiKey(provider: string): string | undefined };
    },
  ) {
    this.corpus = options.corpus ?? new DefaultCorpusService();
    this.profiles = options.profiles ?? new WritingProfileService(options.config);
    this.archive = options.archive ?? { passages: () => [] };
    this.coordinator = this.makeCoordinator(options.project);
    this.styleGate = new PatchStyleGate({
      models: options.models,
      config: options.config,
      patches: options.patches,
      profiles: this.profiles,
      credentials: options.credentials,
    });
  }

  async startTurn(input: StartTurnRequest): Promise<{ runId: string }> {
    this.assertIdle();
    const { project } = this.options;
    const requestedArchiveIds = [...new Set(input.archivePassageIds ?? [])];
    const archivePassages = this.archive.passages(requestedArchiveIds);
    if (archivePassages.length !== requestedArchiveIds.length) {
      throw new Error('one or more attached archive passages are no longer available');
    }
    const assembled = assembleContext(
      project,
      input.scope,
      DOC_BUDGET_CHARS,
      archivePassages,
    );
    const modeConfig = this.options.config.modes[input.mode];
    const model = this.options.models.getModel(modeConfig.provider, modeConfig.model);
    if (!model) {
      throw new Error(
        `model not found: ${modeConfig.provider}/${modeConfig.model} — check config.json`,
      );
    }

    const conversationContext = this.options.conversations.context(input.conversationId);
    const skill = skillById(conversationContext.skillId);
    const agent = this.agentFor(input.conversationId, model, skill?.id);
    if (agent.state.isStreaming) {
      // Our run map cleared at agent_end; the agent may still be settling
      // listeners — wait for that, then proceed.
      await agent.waitForIdle();
    }
    // Refresh per-turn state: context-bearing system prompt + model mode.
    // Between turns the agent gets a compact diff of what changed since the
    // last revision it saw (plan §11) — not a blind full re-read.
    const lastRun = this.options.conversations.latestRun(input.conversationId);
    const sameDoc = lastRun?.manifest?.documentId === assembled.manifest.documentId;
    const lastSeen = sameDoc ? lastRun?.manifest?.baseRevision : undefined;
    let changeSummary: ChangeSummary | 'unchanged' | null = null;
    if (lastSeen !== undefined && lastRun?.manifest) {
      // Revision coalescing appends user typing to the tip revision, so the
      // diff anchor is (revision, change count). Manifests from before
      // coalescing carry no count: MAX keeps the old seq-only behavior —
      // the full current text is in the context anyway.
      changeSummary =
        summarizeChangesSince(project.db, assembled.manifest.documentId, lastSeen, {
          sinceChangeCount: lastRun.manifest.baseChangeCount ?? Number.MAX_SAFE_INTEGER,
        }) ?? 'unchanged';
    }
    agent.state.systemPrompt = this.systemPrompt(assembled, changeSummary, skill?.instructions);
    agent.state.model = model;

    const runId = this.options.conversations.startRun({
      conversationId: input.conversationId,
      modelMode: input.mode,
      provider: modeConfig.provider,
      model: modeConfig.model,
      manifest: assembled.manifest,
      skillId: skill?.id,
      skillVersion: skill?.version,
    });
    this.activeRunContext = {
      conversationId: input.conversationId,
      runId,
      documentId: assembled.manifest.documentId,
      task: input.text,
      skillId: skill?.id,
    };

    const queue = new EventQueue<NormalizedAgentEvent>();
    const run: ActiveRun = {
      runId,
      conversationId: input.conversationId,
      mode: input.mode,
      agent,
      queue,
      unsubscribe: () => undefined,
      manifest: assembled.manifest,
    };
    run.unsubscribe = agent.subscribe((event) => {
      // Keep this listener fast — awaited subscribers block run settlement.
      for (const normalized of normalizeEvent(runId, input.mode, event)) {
        queue.push(normalized);
      }
      if (event.type === 'agent_end') {
        this.finishRun(run, event.messages);
      }
    });
    this.runs.set(runId, run);
    queue.push({ type: 'run_start', runId, mode: input.mode });

    agent.prompt(input.text).catch((err: unknown) => {
      // A deletion or project switch may already have aborted, finalized, and
      // detached this run. Never let a late rejected prompt write through the
      // replacement project's services.
      if (!this.runs.has(runId)) return;
      queue.push({
        type: 'run_end',
        runId,
        status: 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
        manifest: assembled.manifest,
      });
      this.options.conversations.finishRun(runId, {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
      this.teardown(run);
    });
    return { runId };
  }

  events(runId: string): AsyncIterable<NormalizedAgentEvent> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`unknown run: ${runId}`);
    }
    return run.queue;
  }

  async cancel(runId: string): Promise<void> {
    this.runs.get(runId)?.agent.abort();
  }

  assertIdle(): void {
    if (this.runs.size > 0) {
      throw new Error('another turn is already in progress; cancel it before starting new work');
    }
  }

  cancelConversation(conversationId: string): void {
    const run = [...this.runs.values()].find((candidate) => candidate.conversationId === conversationId);
    if (run) this.abortAndTeardown(run, 'conversation deleted');
    this.agents.delete(conversationId);
  }

  /** Swap the project (project manager): agents and pending runs reset. */
  setProject(
    project: ProjectContext,
    conversations: ConversationService,
    patches: PatchService,
  ): void {
    // Detach old agents before changing service ownership. Otherwise a late
    // agent_end would append old-project messages through the new project's
    // ConversationService.
    for (const run of [...this.runs.values()]) {
      this.abortAndTeardown(run, 'project switched');
    }
    this.options.project = project;
    this.options.conversations = conversations;
    this.options.patches = patches;
    this.coordinator.cancelAll();
    this.coordinator = this.makeCoordinator(project);
    this.styleGate.setPatchService(patches);
    this.agents.clear();
  }

  /** One Agent per conversation; history replayed verbatim from SQLite. */
  private agentFor(conversationId: string, model: Agent['state']['model'], skillId?: string): Agent {
    const existing = this.agents.get(conversationId);
    if (existing) {
      return existing;
    }
    const messages = this.options.conversations.listAgentMessages(conversationId);
    const agent = new Agent({
      initialState: {
        systemPrompt: '',
        model,
        tools: createAgentTools(
          this.options.project,
          this.options.patches,
          () => this.activeRunContext,
          {
            conversationId,
            skillId,
            corpus: this.corpus,
            profiles: this.profiles,
            coordinator: this.coordinator,
            propose: (runId, task, input, origin) => this.styleGate.propose(runId, task, input, origin),
            verifyApproval: (id, quote) => this.options.conversations.latestUserText(id).includes(quote),
            onProfileArtifacts: (artifacts) => {
              const current = this.activeRunContext;
              if (!current) return;
              this.runs.get(current.runId)?.queue.push({
                type: 'profile_artifacts_created',
                runId: current.runId,
                ...artifacts,
              });
            },
          },
        ),
        messages,
      },
      streamFn: (m, c, o) => this.options.models.streamSimple(m, c, o),
      getApiKey: (provider) => this.options.credentials?.getApiKey(provider),
      transformContext: async (messages) => compactToolContext(messages),
    });
    this.agents.set(conversationId, agent);
    return agent;
  }

  private finishRun(run: ActiveRun, newMessages: AgentMessage[]): void {
    const { conversations } = this.options;
    conversations.appendMessages(run.conversationId, newMessages, {
      runId: run.runId,
      mode: run.mode,
      manifest: run.manifest,
    });

    const assistant = newMessages.filter((m) => m.role === 'assistant');
    const usage = sumUsage(assistant);
    const failed = assistant.find(
      (m) => m.stopReason === 'error' || m.stopReason === 'aborted',
    );
    const status = failed
      ? failed.stopReason === 'aborted'
        ? 'aborted'
        : 'error'
      : 'completed';
    conversations.finishRun(run.runId, {
      status,
      usage,
      error: failed?.errorMessage,
    });
    this.styleGate.finalize(run.runId);

    run.queue.push({
      type: 'run_end',
      runId: run.runId,
      status,
      errorMessage: failed?.errorMessage,
      usage,
      manifest: run.manifest,
    });
    this.teardown(run);
  }

  private systemPrompt(
    assembled: ReturnType<typeof assembleContext>,
    changes: ChangeSummary | 'unchanged' | null,
    skillInstructions?: string,
  ): string {
    const parts = [buildSystemPrompt(assembled, changes)];
    const profile = this.profiles.read('writing-profile');
    if (profile) {
      parts.push(
        '<writing-policy>',
        'Apply the profile only when drafting or revising prose. Current user instructions and user-confirmed preferences override inferred habits. Genre and audience justify natural variation. Do not invent opinions, mechanically repeat conspicuous tics, or make ordinary connective prose artificially characteristic.',
        '</writing-policy>',
        `<writing-profile report-ref="texeris-profile:${this.options.config.activeProfileId}/writing-style-report.md">`,
        profile,
        '</writing-profile>',
      );
    }
    if (skillInstructions) parts.push('<active-skill>', skillInstructions, '</active-skill>');
    return parts.join('\n\n');
  }

  private makeCoordinator(project: ProjectContext): AgentCoordinator {
    return new AgentCoordinator({
      models: this.options.models,
      config: this.options.config,
      db: project.db,
      credentials: this.options.credentials,
      onEvent: (event) => {
        const parent = this.activeRunContext;
        if (!parent) return;
        this.runs.get(parent.runId)?.queue.push({
          type: event.type,
          runId: parent.runId,
          delegationId: event.result.id,
          role: event.result.role,
          status: event.type === 'delegation_start' ? 'running' : event.result.status,
          summary: event.result.summary,
        });
      },
    });
  }

  private teardown(run: ActiveRun): void {
    run.unsubscribe();
    run.queue.close();
    if (this.activeRunContext?.runId === run.runId) {
      this.activeRunContext = null;
    }
    this.runs.delete(run.runId);
  }

  private abortAndTeardown(run: ActiveRun, reason: string): void {
    run.agent.abort();
    this.options.conversations.finishRun(run.runId, {
      status: 'aborted',
      error: reason,
    });
    this.styleGate.finalize(run.runId);
    run.queue.push({
      type: 'run_end',
      runId: run.runId,
      status: 'aborted',
      errorMessage: reason,
      manifest: run.manifest,
    });
    this.teardown(run);
  }
}

function compactToolContext(messages: AgentMessage[]): AgentMessage[] {
  let corpusReads = 0;
  for (const message of messages) {
    if (message.role === 'toolResult' && message.toolName === 'read_corpus_source') corpusReads += 1;
  }
  if (corpusReads <= 6) return messages;
  let keep = 6;
  return [...messages].reverse().map((message) => {
    if (message.role !== 'toolResult' || message.toolName !== 'read_corpus_source') return message;
    if (keep-- > 0) return message;
    return {
      ...message,
      content: [{ type: 'text' as const, text: '[Earlier corpus passage elided from model context; its full tool result remains in conversation storage.]' }],
      details: { compacted: true },
    };
  }).reverse();
}

function normalizeEvent(
  runId: string,
  _mode: ModelMode,
  event: Parameters<Parameters<Agent['subscribe']>[0]>[0],
): NormalizedAgentEvent[] {
  switch (event.type) {
    case 'message_update': {
      const inner = event.assistantMessageEvent;
      if (inner.type === 'text_delta') {
        return [{ type: 'text_delta', runId, delta: inner.delta }];
      }
      if (inner.type === 'thinking_delta') {
        return [{ type: 'thinking_delta', runId, delta: inner.delta }];
      }
      return [];
    }
    case 'tool_execution_start':
      return [
        {
          type: 'tool_start',
          runId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        },
      ];
    case 'tool_execution_end':
      return [
        {
          type: 'tool_end',
          runId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
        },
      ];
    default:
      return [];
  }
}

function sumUsage(
  assistantMessages: Extract<AgentMessage, { role: 'assistant' }>[],
): UsageSummary | undefined {
  if (assistantMessages.length === 0) {
    return undefined;
  }
  const total: UsageSummary = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let reasoning = 0;
  let hasReasoning = false;
  for (const message of assistantMessages) {
    total.input += message.usage.input;
    total.output += message.usage.output;
    total.cacheRead += message.usage.cacheRead;
    total.cacheWrite += message.usage.cacheWrite;
    if (message.usage.reasoning !== undefined) {
      reasoning += message.usage.reasoning;
      hasReasoning = true;
    }
  }
  if (hasReasoning) {
    total.reasoning = reasoning;
  }
  return total;
}
