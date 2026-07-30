import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { Value } from '@sinclair/typebox/value';
import type {
  AgentRunRecord,
  ContextManifest,
  ModelMode,
  RunStatus,
  UiMessage,
  UsageSummary,
  DelegationRecord,
} from '../../shared/chat-types';
import {
  TurnContextSchema,
  type TurnContext,
} from '../../shared/chat-types';

interface RunRow {
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
  parent_run_id?: string | null;
  role_id?: string | null;
  skill_id?: string | null;
  skill_version?: number | null;
}

export interface MessageEditBoundary {
  conversationId: string;
  messageSeq: number;
  text: string;
  title: string;
  context: TurnContext;
  boundaryExact: boolean;
  laterMessageCount: number;
}

function mapRun(row: RunRow): AgentRunRecord {
  return {
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
    parentRunId: row.parent_run_id ?? null,
    roleId: row.role_id ?? null,
    skillId: row.skill_id ?? null,
    skillVersion: row.skill_version ?? null,
  };
}

/**
 * Conversation persistence (plan §10.4): one conversation per project in M1,
 * messages stored as verbatim Pi AgentMessage JSON so runs can be replayed
 * (provider fields preserved). agent_runs records provider/model/usage/
 * manifest per run (spec §13.2 signal collection).
 */
export class ConversationService {
  /**
   * afterDelete runs after a conversation delete commits — used to GC
   * unreferenced corpus blobs so conversation deletion doesn't orphan them.
   */
  constructor(
    private readonly db: DatabaseSync,
    private readonly afterDelete?: () => void,
  ) {
    this.reconcileInterruptedRuns();
  }

  /** The active conversation = the most recent one (one per project at a time). */
  getOrCreateConversation(): string {
    const existing = this.db
      .prepare('SELECT id FROM conversations ORDER BY rowid DESC LIMIT 1')
      .get() as { id: string } | undefined;
    if (existing) {
      return existing.id;
    }
    return this.startNewConversation();
  }

  /** Start a fresh conversation (prior ones stay in history storage). */
  startNewConversation(skill?: { id: string; version: number }): string {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO conversations (id, title, created_at, skill_id, skill_version) VALUES (?, ?, ?, ?, ?)')
      .run(id, skill ? 'Build writing profile' : 'Conversation', new Date().toISOString(), skill?.id ?? null, skill?.version ?? null);
    return id;
  }

  context(conversationId: string): { skillId: string | null; skillVersion: number | null; corpusGrantId: string | null } {
    const row = this.db.prepare(
      'SELECT skill_id, skill_version, corpus_grant_id FROM conversations WHERE id = ?',
    ).get(conversationId) as { skill_id: string | null; skill_version: number | null; corpus_grant_id: string | null } | undefined;
    if (!row) throw new Error(`unknown conversation: ${conversationId}`);
    return { skillId: row.skill_id, skillVersion: row.skill_version, corpusGrantId: row.corpus_grant_id };
  }

  /** All conversations, newest first, for the picker (M1.5 EU3). */
  listConversations(): Array<{
    id: string;
    title: string;
    createdAt: string;
    messageCount: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.title, c.created_at, COUNT(m.id) AS message_count
         FROM conversations c
         LEFT JOIN messages m ON m.conversation_id = c.id
         GROUP BY c.id
         ORDER BY c.created_at DESC, c.rowid DESC`,
      )
      .all() as Array<{ id: string; title: string; created_at: string; message_count: number }>;
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      messageCount: row.message_count,
    }));
  }

  renameConversation(conversationId: string, title: string): void {
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error('conversation title cannot be empty');
    }
    this.db
      .prepare('UPDATE conversations SET title = ? WHERE id = ?')
      .run(trimmed, conversationId);
  }

  /** Delete a conversation and every conversation-owned profile/run record. */
  deleteConversation(conversationId: string): void {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('DELETE FROM delegated_results WHERE conversation_id = ?')
        .run(conversationId);
      this.db
        .prepare('DELETE FROM corpus_sources WHERE grant_id IN (SELECT id FROM corpus_grants WHERE conversation_id = ?)')
        .run(conversationId);
      this.db.prepare('DELETE FROM corpus_grants WHERE conversation_id = ?').run(conversationId);
      this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
      this.db.prepare('DELETE FROM agent_runs WHERE conversation_id = ?').run(conversationId);
      this.db.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.afterDelete?.();
  }

  /** Append messages verbatim; returns the first assigned seq. */
  appendMessages(
    conversationId: string,
    messages: readonly AgentMessage[],
    turnContext?: TurnContext,
  ): number {
    const maxSeq = (
      this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM messages WHERE conversation_id = ?')
        .get(conversationId) as { max_seq: number }
    ).max_seq;
    const insert = this.db.prepare(
      `INSERT INTO messages
         (id, conversation_id, seq, role, payload_json, created_at, turn_context_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    let storedTurnContext = false;
    messages.forEach((message, i) => {
      const contextJson =
        !storedTurnContext && message.role === 'user' && turnContext
          ? JSON.stringify(turnContext)
          : null;
      if (contextJson) storedTurnContext = true;
      insert.run(
        randomUUID(),
        conversationId,
        maxSeq + 1 + i,
        message.role,
        JSON.stringify(message),
        new Date().toISOString(),
        contextJson,
      );
    });
    // Auto-title from the first user message while the default title stands.
    const conv = this.db
      .prepare('SELECT title FROM conversations WHERE id = ?')
      .get(conversationId) as { title: string } | undefined;
    if (conv?.title === 'Conversation') {
      const firstUser = messages.find((m) => m.role === 'user');
      const text = firstUser ? userText(firstUser.content).trim() : '';
      if (text) {
        this.db
          .prepare('UPDATE conversations SET title = ? WHERE id = ?')
          .run(text.length > 48 ? `${text.slice(0, 48)}…` : text, conversationId);
      }
    }
    return maxSeq + 1;
  }

  /** Resolve the immutable context boundary associated with a user message. */
  messageEditBoundary(conversationId: string, messageSeq: number): MessageEditBoundary {
    const row = this.db
      .prepare(
        `SELECT m.role, m.payload_json, m.turn_context_json, c.title, c.skill_id,
                (SELECT COUNT(*) FROM messages later
                 WHERE later.conversation_id = m.conversation_id AND later.seq > m.seq) AS later_count
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE m.conversation_id = ? AND m.seq = ?`,
      )
      .get(conversationId, messageSeq) as
      | {
          role: string;
          payload_json: string;
          turn_context_json: string | null;
          title: string;
          skill_id: string | null;
          later_count: number;
        }
      | undefined;
    if (!row) throw new Error('message is no longer available');
    if (row.role !== 'user') throw new Error('only user messages can be edited');
    if (row.skill_id) {
      throw new Error('skill conversations cannot be branched by editing a message');
    }
    if (!row.turn_context_json) {
      throw new Error('this message predates exact edit boundaries and cannot be edited safely');
    }
    const message = JSON.parse(row.payload_json) as AgentMessage;
    const context = Value.Decode(TurnContextSchema, JSON.parse(row.turn_context_json));
    return {
      conversationId,
      messageSeq,
      text: message.role === 'user' ? userText(message.content) : '',
      title: row.title,
      context,
      boundaryExact: context.manifest.baseChangeCount !== undefined,
      laterMessageCount: row.later_count,
    };
  }

  /**
   * Copy transcript messages before the edited user message into a new
   * conversation. Runs, delegations, patches, and corpus grants remain owned
   * by the original conversation.
   */
  forkAtUserMessage(
    conversationId: string,
    messageSeq: number,
    reason: 'edit' | 'regenerate' = 'edit',
  ): string {
    const boundary = this.messageEditBoundary(conversationId, messageSeq);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const suffix = reason === 'regenerate' ? 'regenerated' : 'edited';
    const titleBase = boundary.title.replace(/ \((edited|regenerated)\)$/, '');
    const title = `${titleBase} (${suffix})`;
    const messages = this.db
      .prepare(
        `SELECT seq, role, payload_json, created_at, turn_context_json
         FROM messages
         WHERE conversation_id = ? AND seq < ?
         ORDER BY seq`,
      )
      .all(conversationId, messageSeq) as Array<{
        seq: number;
        role: string;
        payload_json: string;
        created_at: string;
        turn_context_json: string | null;
      }>;

    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO conversations
             (id, title, created_at, skill_id, skill_version, corpus_grant_id,
              parent_conversation_id, forked_from_message_seq)
           VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?)`,
        )
        .run(id, title, createdAt, conversationId, messageSeq);
      const insert = this.db.prepare(
        `INSERT INTO messages
           (id, conversation_id, seq, role, payload_json, created_at, turn_context_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const message of messages) {
        insert.run(
          randomUUID(),
          id,
          message.seq,
          message.role,
          message.payload_json,
          message.created_at,
          message.turn_context_json,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return id;
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

  latestUserText(conversationId: string): string {
    const row = this.db.prepare(
      `SELECT payload_json FROM messages
       WHERE conversation_id = ? AND role = 'user' ORDER BY seq DESC LIMIT 1`,
    ).get(conversationId) as { payload_json: string } | undefined;
    if (!row) return '';
    const message = JSON.parse(row.payload_json) as AgentMessage;
    return message.role === 'user' ? userText(message.content) : '';
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
    skillId?: string | null;
    skillVersion?: number | null;
  }): string {
    const id = randomUUID();
    this.insertRun(id, input);
    return id;
  }

  /** Persist the submitted prompt and its run boundary before provider work. */
  startTurn(
    input: {
      conversationId: string;
      modelMode: ModelMode;
      provider: string;
      model: string;
      manifest: ContextManifest;
      skillId?: string | null;
      skillVersion?: number | null;
    },
    text: string,
  ): string {
    const id = randomUUID();
    const message: AgentMessage = {
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    this.db.exec('BEGIN');
    try {
      this.appendMessages(input.conversationId, [message], {
        runId: id,
        mode: input.modelMode,
        manifest: input.manifest,
      });
      this.insertRun(id, input);
      this.db.exec('COMMIT');
      return id;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private insertRun(
    id: string,
    input: {
      conversationId: string;
      modelMode: ModelMode;
      provider: string;
      model: string;
      manifest: ContextManifest;
      skillId?: string | null;
      skillVersion?: number | null;
    },
  ): void {
    this.db
      .prepare(
        `INSERT INTO agent_runs
           (id, conversation_id, model_mode, provider, model, status,
            started_at, usage_json, context_manifest_json, skill_id, skill_version)
         VALUES (?, ?, ?, ?, ?, 'running', ?, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        input.conversationId,
        input.modelMode,
        input.provider,
        input.model,
        new Date().toISOString(),
        JSON.stringify(input.manifest),
        input.skillId ?? null,
        input.skillVersion ?? null,
      );
  }

  private reconcileInterruptedRuns(): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE agent_runs
         SET status = 'aborted', ended_at = ?,
             error_json = ?
         WHERE status = 'running'`,
      )
      .run(
        now,
        JSON.stringify({ message: 'application closed before the run completed' }),
      );
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
                started_at, ended_at, usage_json, context_manifest_json, error_json,
                parent_run_id, role_id, skill_id, skill_version
         FROM agent_runs WHERE conversation_id = ? ORDER BY started_at`,
      )
      .all(conversationId) as unknown as RunRow[];
    return rows.map(mapRun);
  }

  /** The most recent run (by insertion order), for last-seen revision. */
  latestRun(conversationId: string): AgentRunRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, conversation_id, model_mode, provider, model, status,
                started_at, ended_at, usage_json, context_manifest_json, error_json,
                parent_run_id, role_id, skill_id, skill_version
         FROM agent_runs WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1`,
      )
      .get(conversationId) as RunRow | undefined;
    return row ? mapRun(row) : null;
  }

  listDelegations(conversationId: string): DelegationRecord[] {
    const rows = this.db.prepare(
      `SELECT id, parent_run_id, role_id, status, task, summary, provider, model,
              created_at, ended_at
       FROM delegated_results WHERE conversation_id = ? ORDER BY created_at`,
    ).all(conversationId) as Array<{
      id: string; parent_run_id: string; role_id: string; status: DelegationRecord['status'];
      task: string; summary: string | null; provider: string; model: string;
      created_at: string; ended_at: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id, parentRunId: row.parent_run_id, role: row.role_id,
      status: row.status, task: row.task, summary: row.summary,
      provider: row.provider, model: row.model, createdAt: row.created_at, endedAt: row.ended_at,
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
