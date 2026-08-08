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
  DelegationRecord,
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
  ) {}

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
    return id;
  }

  finishRun(
    runId: string,
    outcome: {
      status: RunStatus;
      usage?: UsageSummary;
      error?: string;
      /** End-of-turn boundary for rewind (migration 0005): last message seq
       * of the turn and the document revision current at turn end. */
      endMessageSeq?: number | null;
      endRevision?: number | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE agent_runs
         SET status = ?, ended_at = ?, usage_json = ?, error_json = ?,
             end_message_seq = ?, end_revision = ?
         WHERE id = ?`,
      )
      .run(
        outcome.status,
        new Date().toISOString(),
        outcome.usage ? JSON.stringify(outcome.usage) : null,
        outcome.error ? JSON.stringify({ message: outcome.error }) : null,
        outcome.endMessageSeq ?? null,
        outcome.endRevision ?? null,
        runId,
      );
  }

  /**
   * Fork a conversation at a message boundary (rewind, plan G1 §8): copy
   * messages with seq <= boundarySeq and the runs wholly inside the boundary
   * into a NEW conversation with fresh ids. The original conversation, its
   * messages, and its runs are never mutated.
   */
  forkConversation(conversationId: string, boundarySeq: number): string {
    const source = this.db
      .prepare(
        'SELECT title, skill_id, skill_version, corpus_grant_id FROM conversations WHERE id = ?',
      )
      .get(conversationId) as
      | { title: string; skill_id: string | null; skill_version: number | null; corpus_grant_id: string | null }
      | undefined;
    if (!source) {
      throw new Error(`unknown conversation: ${conversationId}`);
    }
    const maxSeq = (
      this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM messages WHERE conversation_id = ?')
        .get(conversationId) as { max_seq: number }
    ).max_seq;
    if (boundarySeq < 1 || boundarySeq > maxSeq) {
      throw new Error(`fork boundary ${boundarySeq} outside message range 1..${maxSeq}`);
    }

    const forkId = randomUUID();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO conversations (id, title, created_at, skill_id, skill_version, corpus_grant_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          forkId,
          `${source.title} (rewind)`,
          new Date().toISOString(),
          source.skill_id,
          source.skill_version,
          source.corpus_grant_id,
        );

      const copyMessage = this.db.prepare(
        `INSERT INTO messages (id, conversation_id, seq, role, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const messages = this.db
        .prepare(
          'SELECT seq, role, payload_json, created_at FROM messages WHERE conversation_id = ? AND seq <= ? ORDER BY seq',
        )
        .all(conversationId, boundarySeq) as Array<{
        seq: number;
        role: string;
        payload_json: string;
        created_at: string;
      }>;
      for (const message of messages) {
        copyMessage.run(randomUUID(), forkId, message.seq, message.role, message.payload_json, message.created_at);
      }

      // Copy finished runs whose recorded boundary fits inside the fork
      // (runs predating migration 0005 have NULL boundaries and are skipped),
      // plus delegated child runs of copied parents; remap parent ids.
      const runs = this.db
        .prepare(
          `SELECT * FROM agent_runs
           WHERE conversation_id = ? AND status != 'running'
           ORDER BY rowid`,
        )
        .all(conversationId) as unknown as Array<{
        id: string;
        model_mode: string;
        provider: string;
        model: string;
        status: string;
        started_at: string;
        ended_at: string | null;
        usage_json: string | null;
        context_manifest_json: string | null;
        error_json: string | null;
        parent_run_id: string | null;
        role_id: string | null;
        skill_id: string | null;
        skill_version: number | null;
        result_json: string | null;
        end_message_seq: number | null;
        end_revision: number | null;
      }>;
      const idMap = new Map<string, string>();
      const selected = runs.filter((run) => run.end_message_seq !== null && run.end_message_seq <= boundarySeq);
      for (const run of selected) {
        idMap.set(run.id, randomUUID());
      }
      const copyRun = this.db.prepare(
        `INSERT INTO agent_runs
           (id, conversation_id, model_mode, provider, model, status, started_at,
            ended_at, usage_json, context_manifest_json, error_json, parent_run_id,
            role_id, skill_id, skill_version, result_json, end_message_seq, end_revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const run of selected) {
        const parent = run.parent_run_id;
        copyRun.run(
          idMap.get(run.id) ?? randomUUID(),
          forkId,
          run.model_mode,
          run.provider,
          run.model,
          run.status,
          run.started_at,
          run.ended_at,
          run.usage_json,
          run.context_manifest_json,
          run.error_json,
          parent ? (idMap.get(parent) ?? null) : null,
          run.role_id,
          run.skill_id,
          run.skill_version,
          run.result_json,
          run.end_message_seq,
          run.end_revision,
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return forkId;
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

export function userText(content: unknown): string {
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
