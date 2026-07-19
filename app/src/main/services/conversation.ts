import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type {
  AgentRunRecord,
  ContextManifest,
  ModelMode,
  RunStatus,
  UiMessage,
  UsageSummary,
} from '../../shared/chat-types';

/**
 * Conversation persistence (plan §10.4): one conversation per project in M1,
 * messages stored as verbatim Pi AgentMessage JSON so runs can be replayed
 * (provider fields preserved). agent_runs records provider/model/usage/
 * manifest per run (spec §13.2 signal collection).
 */
export class ConversationService {
  constructor(private readonly db: DatabaseSync) {}

  getOrCreateConversation(): string {
    const existing = this.db
      .prepare('SELECT id FROM conversations ORDER BY created_at LIMIT 1')
      .get() as { id: string } | undefined;
    if (existing) {
      return existing.id;
    }
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO conversations (id, title, created_at) VALUES (?, ?, ?)')
      .run(id, 'Conversation', new Date().toISOString());
    return id;
  }

  /** Append messages verbatim; returns the first assigned seq. */
  appendMessages(conversationId: string, messages: readonly AgentMessage[]): number {
    const maxSeq = (
      this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM messages WHERE conversation_id = ?')
        .get(conversationId) as { max_seq: number }
    ).max_seq;
    const insert = this.db.prepare(
      `INSERT INTO messages (id, conversation_id, seq, role, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    messages.forEach((message, i) => {
      insert.run(
        randomUUID(),
        conversationId,
        maxSeq + 1 + i,
        message.role,
        JSON.stringify(message),
        new Date().toISOString(),
      );
    });
    return maxSeq + 1;
  }

  /** Verbatim AgentMessages for replay into agent.state.messages. */
  listAgentMessages(conversationId: string): AgentMessage[] {
    const rows = this.db
      .prepare(
        'SELECT payload_json FROM messages WHERE conversation_id = ? ORDER BY seq',
      )
      .all(conversationId) as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as AgentMessage);
  }

  /** Renderer-facing view of the transcript. */
  listUiMessages(conversationId: string): UiMessage[] {
    const rows = this.db
      .prepare(
        'SELECT seq, role, payload_json FROM messages WHERE conversation_id = ? ORDER BY seq',
      )
      .all(conversationId) as Array<{ seq: number; role: string; payload_json: string }>;
    const out: UiMessage[] = [];
    for (const row of rows) {
      const message = JSON.parse(row.payload_json) as AgentMessage;
      if (message.role === 'user') {
        out.push({ seq: row.seq, role: 'user', text: userText(message.content) });
      } else if (message.role === 'assistant') {
        const text = message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('');
        out.push({ seq: row.seq, role: 'assistant', text });
      } else if (message.role === 'toolResult') {
        out.push({
          seq: row.seq,
          role: 'tool',
          text: message.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join(''),
          toolName: message.toolName,
          isError: message.isError,
        });
      }
    }
    return out;
  }

  startRun(input: {
    conversationId: string;
    modelMode: ModelMode;
    provider: string;
    model: string;
    manifest: ContextManifest;
  }): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO agent_runs
           (id, conversation_id, model_mode, provider, model, status,
            started_at, usage_json, context_manifest_json)
         VALUES (?, ?, ?, ?, ?, 'running', ?, NULL, ?)`,
      )
      .run(
        id,
        input.conversationId,
        input.modelMode,
        input.provider,
        input.model,
        new Date().toISOString(),
        JSON.stringify(input.manifest),
      );
    return id;
  }

  finishRun(
    runId: string,
    outcome: { status: RunStatus; usage?: UsageSummary; error?: string },
  ): void {
    this.db
      .prepare(
        `UPDATE agent_runs
         SET status = ?, ended_at = ?, usage_json = ?, error_json = ?
         WHERE id = ?`,
      )
      .run(
        outcome.status,
        new Date().toISOString(),
        outcome.usage ? JSON.stringify(outcome.usage) : null,
        outcome.error ? JSON.stringify({ message: outcome.error }) : null,
        runId,
      );
  }

  listRuns(conversationId: string): AgentRunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, conversation_id, model_mode, provider, model, status,
                started_at, ended_at, usage_json, context_manifest_json, error_json
         FROM agent_runs WHERE conversation_id = ? ORDER BY started_at`,
      )
      .all(conversationId) as Array<{
      id: string;
      conversation_id: string;
      model_mode: string;
      provider: string;
      model: string;
      status: string;
      started_at: string;
      ended_at: string | null;
      usage_json: string | null;
      context_manifest_json: string | null;
      error_json: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      modelMode: row.model_mode as ModelMode,
      provider: row.provider,
      model: row.model,
      status: row.status as RunStatus,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      usage: row.usage_json ? (JSON.parse(row.usage_json) as UsageSummary) : null,
      manifest: row.context_manifest_json
        ? (JSON.parse(row.context_manifest_json) as ContextManifest)
        : null,
      error: row.error_json
        ? (JSON.parse(row.error_json) as { message: string }).message
        : null,
    }));
  }
}

function userText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: 'text'; text: string } =>
          typeof block === 'object' &&
          block !== null &&
          (block as { type?: string }).type === 'text',
      )
      .map((block) => block.text)
      .join('');
  }
  return '';
}
