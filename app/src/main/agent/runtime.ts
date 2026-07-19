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
import { assembleContext, buildSystemPrompt } from './context';
import { createAgentTools } from './tools';

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
  agent: Agent;
  queue: EventQueue<NormalizedAgentEvent>;
  unsubscribe: () => void;
  manifest: ContextManifest;
}

export class PiAgentRuntime implements AgentRuntime {
  private readonly agents = new Map<string, Agent>();
  private readonly runs = new Map<string, ActiveRun>();
  /** Run context handed to tools (patch origin) while a run is active. */
  private activeRunContext: { conversationId: string; runId: string } | null = null;

  constructor(
    private readonly options: {
      models: Models;
      config: WorkspaceConfig;
      conversations: ConversationService;
      project: ProjectContext;
      patches: PatchService;
      /** Per-provider key lookup (stored keychain key wins over env). */
      credentials?: { getApiKey(provider: string): string | undefined };
    },
  ) {}

  async startTurn(input: StartTurnRequest): Promise<{ runId: string }> {
    const { project } = this.options;
    const assembled = assembleContext(project, input.scope);
    const modeConfig = this.options.config.modes[input.mode];
    const model = this.options.models.getModel(modeConfig.provider, modeConfig.model);
    if (!model) {
      throw new Error(
        `model not found: ${modeConfig.provider}/${modeConfig.model} — check config.json`,
      );
    }

    const agent = this.agentFor(input.conversationId, model);
    if (agent.state.isStreaming) {
      throw new Error('a turn is already in progress for this conversation');
    }
    // Refresh per-turn state: context-bearing system prompt + model mode.
    agent.state.systemPrompt = buildSystemPrompt(assembled);
    agent.state.model = model;

    const runId = this.options.conversations.startRun({
      conversationId: input.conversationId,
      modelMode: input.mode,
      provider: modeConfig.provider,
      model: modeConfig.model,
      manifest: assembled.manifest,
    });
    this.activeRunContext = { conversationId: input.conversationId, runId };

    const queue = new EventQueue<NormalizedAgentEvent>();
    const run: ActiveRun = {
      runId,
      conversationId: input.conversationId,
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

  /** One Agent per conversation; history replayed verbatim from SQLite. */
  private agentFor(conversationId: string, model: Agent['state']['model']): Agent {
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
        ),
        messages,
      },
      streamFn: (m, c, o) => this.options.models.streamSimple(m, c, o),
      getApiKey: (provider) => this.options.credentials?.getApiKey(provider),
    });
    this.agents.set(conversationId, agent);
    return agent;
  }

  private finishRun(run: ActiveRun, newMessages: AgentMessage[]): void {
    const { conversations } = this.options;
    conversations.appendMessages(run.conversationId, newMessages);

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

  private teardown(run: ActiveRun): void {
    run.unsubscribe();
    run.queue.close();
    if (this.activeRunContext?.runId === run.runId) {
      this.activeRunContext = null;
    }
    this.runs.delete(run.runId);
  }
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
