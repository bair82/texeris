import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core';
import type { Models } from '@earendil-works/pi-ai';
import type { DatabaseSync } from 'node:sqlite';
import type { WorkspaceConfig } from './settings';
import type { CheckpointService } from './checkpoint';

const MAX_DESCRIPTION = 100;
const MAX_CHANGE_CHARS = 2000;

const SYSTEM_PROMPT = `You write checkpoint descriptions for a writer's revision history. \
Given the most recent changes to a document, reply with ONE short line (at most 12 words) \
describing what changed or what state the document is in — concrete enough to recognize the \
checkpoint later. Reply with the description only: no quotes, no preamble, no trailing period.`;

/**
 * LLM-generated checkpoint descriptions (owner request 2026-08-08). Creation
 * stays instant: CheckpointService writes a deterministic fallback, then
 * schedule() rewrites the description in the background with the fast model
 * and notifies via onUpdated. Any failure (feature disabled, no model, no
 * key, provider error, empty reply) leaves the fallback in place.
 */
export class CheckpointDescriber {
  constructor(
    private readonly options: {
      db: DatabaseSync;
      checkpoints: CheckpointService;
      models: Models;
      config: WorkspaceConfig;
      credentials?: { getApiKey(provider: string): string | undefined };
      onUpdated?: (checkpointId: string) => void;
    },
  ) {}

  /** Fire-and-forget; never throws. */
  schedule(checkpointId: string): void {
    void this.describe(checkpointId).catch(() => undefined);
  }

  private async describe(checkpointId: string): Promise<void> {
    const { db, checkpoints, models, config } = this.options;
    if (!config.llmCheckpointDescriptions) {
      return;
    }
    const checkpoint = checkpoints.get(checkpointId);
    if (!checkpoint) {
      return;
    }
    const modelConfig = config.modes.fast;
    const model = models.getModel(modelConfig.provider, modelConfig.model);
    if (!model) {
      return;
    }

    const doc = db
      .prepare('SELECT title FROM documents WHERE id = ?')
      .get(checkpoint.documentId) as { title: string } | undefined;
    const changes = db
      .prepare(
        `SELECT deleted_text, inserted_text FROM revision_changes
         WHERE document_id = ? AND seq = ? ORDER BY idx`,
      )
      .all(checkpoint.documentId, checkpoint.revisionSeq) as Array<{
      deleted_text: string;
      inserted_text: string;
    }>;
    const payload = {
      document: doc?.title ?? checkpoint.documentId,
      revision: checkpoint.revisionSeq,
      revisionSummary: summaryOf(db, checkpoint.documentId, checkpoint.revisionSeq),
      changes: truncateChanges(changes),
    };

    let ended: AgentMessage[] = [];
    const agent = new Agent({
      initialState: { systemPrompt: SYSTEM_PROMPT, model, tools: [], messages: [] },
      streamFn: (m, c, o) => this.options.models.streamSimple(m, c, o),
      getApiKey: (provider) => this.options.credentials?.getApiKey(provider),
    });
    const unsubscribe = agent.subscribe((event) => {
      if (event.type === 'agent_end') ended = event.messages;
    });
    try {
      await agent.prompt(JSON.stringify(payload));
    } finally {
      unsubscribe();
    }
    const description = sanitize(lastText(ended));
    if (!description) {
      return;
    }
    checkpoints.rename(checkpointId, { description });
    this.options.onUpdated?.(checkpointId);
  }
}

function summaryOf(db: DatabaseSync, documentId: string, seq: number): string {
  const row = db
    .prepare('SELECT summary FROM revisions WHERE document_id = ? AND seq = ?')
    .get(documentId, seq) as { summary: string } | undefined;
  return row?.summary ?? '';
}

/** Cap the payload while keeping every change at least partially visible. */
function truncateChanges(
  changes: Array<{ deleted_text: string; inserted_text: string }>,
): Array<{ removed: string; added: string }> {
  const out: Array<{ removed: string; added: string }> = [];
  let budget = MAX_CHANGE_CHARS;
  for (const change of changes) {
    if (budget <= 0) break;
    const removed = change.deleted_text.slice(0, budget);
    budget -= removed.length;
    const added = change.inserted_text.slice(0, Math.max(0, budget));
    budget -= added.length;
    out.push({ removed, added });
  }
  return out;
}

/** One line, no quotes/preamble/trailing period, length-capped. */
function sanitize(raw: string): string {
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) {
    return '';
  }
  const cleaned = line.replace(/^["'“”]+|["'“”.]+$/g, '').trim();
  if (!cleaned) {
    return '';
  }
  return cleaned.length > MAX_DESCRIPTION ? `${cleaned.slice(0, MAX_DESCRIPTION)}…` : cleaned;
}

function lastText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant') {
      return m.content
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('');
    }
  }
  return '';
}
