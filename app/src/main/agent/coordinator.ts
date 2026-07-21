import { randomUUID } from 'node:crypto';
import { Agent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core';
import type { Models } from '@earendil-works/pi-ai';
import type { DatabaseSync } from 'node:sqlite';
import type { ModelMode, UsageSummary } from '../../shared/chat-types';
import type { WorkspaceConfig } from '../services/settings';

export type SubagentRole = 'conversion-reviewer' | 'metadata-researcher' | 'corpus-analyst';

const ROLE_PROMPTS: Record<SubagentRole, string> = {
  'conversion-reviewer':
    'You inspect deterministic document conversions. Report omissions, encoding damage, broken structure, and extraction warnings. Never reconstruct or invent missing prose.',
  'metadata-researcher':
    'You identify publication metadata conservatively. Use only supplied metadata tools. Return candidate dates with evidence, record identifiers, confidence, and conflicts; never guess.',
  'corpus-analyst':
    'You analyze assigned writing samples for voice, reasoning, and expressed intellectual positions. Record exact short evidence with source ids and locations. Distinguish endorsement, attribution, and uncertainty.',
};

export interface DelegationResult {
  id: string;
  role: SubagentRole;
  status: 'completed' | 'error' | 'aborted';
  summary: string;
  usage?: UsageSummary;
  error?: string;
}

export class AgentCoordinator {
  private active = new Map<string, Agent>();
  private slots = 0;
  private slotWaiters: Array<() => void> = [];

  constructor(
    private readonly options: {
      models: Models;
      config: WorkspaceConfig;
      db: DatabaseSync;
      credentials?: { getApiKey(provider: string): string | undefined };
      onEvent?: (event: { type: 'delegation_start' | 'delegation_end'; result: DelegationResult }) => void;
    },
  ) {}

  async delegate(input: {
    parentRunId: string;
    conversationId: string;
    role: SubagentRole;
    task: string;
    tools: AgentTool<any>[];
    mode?: ModelMode;
  }): Promise<DelegationResult> {
    const id = randomUUID();
    const mode = input.mode ?? (input.role === 'corpus-analyst' ? 'deep' : 'fast');
    const modeConfig = this.options.config.modes[mode];
    const model = this.options.models.getModel(modeConfig.provider, modeConfig.model);
    if (!model) throw new Error(`model not found: ${modeConfig.provider}/${modeConfig.model}`);
    await this.acquireSlot();
    this.options.db.prepare(
      `INSERT INTO delegated_results
       (id, parent_run_id, conversation_id, role_id, status, task, provider, model, created_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
    ).run(id, input.parentRunId, input.conversationId, input.role, input.task, modeConfig.provider, modeConfig.model, new Date().toISOString());
    const started: DelegationResult = { id, role: input.role, status: 'completed', summary: 'Working…' };
    this.options.onEvent?.({ type: 'delegation_start', result: started });
    let endedMessages: AgentMessage[] = [];
    const agent = new Agent({
      initialState: { systemPrompt: ROLE_PROMPTS[input.role], model, tools: input.tools, messages: [] },
      streamFn: (m, c, o) => this.options.models.streamSimple(m, c, o),
      getApiKey: (provider) => this.options.credentials?.getApiKey(provider),
    });
    this.active.set(id, agent);
    const unsubscribe = agent.subscribe((event) => {
      if (event.type === 'agent_end') endedMessages = event.messages;
    });
    try {
      await agent.prompt(input.task);
      const failed = endedMessages.find((message) => message.role === 'assistant' && (message.stopReason === 'error' || message.stopReason === 'aborted')) as Extract<AgentMessage, { role: 'assistant' }> | undefined;
      const status = failed?.stopReason === 'aborted' ? 'aborted' : failed ? 'error' : 'completed';
      const summary = finalText(endedMessages) || failed?.errorMessage || '(subagent returned no text)';
      const result: DelegationResult = { id, role: input.role, status, summary, error: failed?.errorMessage };
      this.finish(id, result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result: DelegationResult = { id, role: input.role, status: 'error', summary: message, error: message };
      this.finish(id, result);
      return result;
    } finally {
      unsubscribe();
      this.active.delete(id);
      this.releaseSlot();
    }
  }

  cancelAll(): void {
    for (const agent of this.active.values()) agent.abort();
  }

  private finish(id: string, result: DelegationResult): void {
    this.options.db.prepare(
      `UPDATE delegated_results SET status = ?, summary = ?, result_json = ?, error_json = ?, ended_at = ? WHERE id = ?`,
    ).run(
      result.status,
      result.summary,
      JSON.stringify(result),
      result.error ? JSON.stringify({ message: result.error }) : null,
      new Date().toISOString(),
      id,
    );
    this.options.onEvent?.({ type: 'delegation_end', result });
  }

  private async acquireSlot(): Promise<void> {
    if (this.slots < 3) {
      this.slots += 1;
      return;
    }
    await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
    this.slots += 1;
  }

  private releaseSlot(): void {
    this.slots -= 1;
    this.slotWaiters.shift()?.();
  }
}

function finalText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    return message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
  }
  return '';
}
