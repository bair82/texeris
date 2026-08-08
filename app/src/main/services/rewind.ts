import type { DatabaseSync } from 'node:sqlite';
import type {
  RewindPendingPatch,
  RewindPoint,
  RewindPreview,
  RewindResult,
} from '../../shared/rewind-types';
import type { CheckpointService } from './checkpoint';
import { userText, type ConversationService } from './conversation';
import type { PatchService } from './patch';
import type { RevisionService } from './revision';

const DESCRIPTION_MAX = 72;

interface TurnRow {
  id: string;
  conversation_id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  end_message_seq: number;
  end_revision: number | null;
  context_manifest_json: string | null;
}

/**
 * Rewind orchestration (G1 §8): lists rewind points (completed top-level
 * turns with a recorded boundary + manual checkpoints), previews the
 * document/message boundary, and applies a rewind. Applying a turn point
 * restores the document as a NEW revision and forks the conversation from
 * the message boundary — the original conversation, runs, and revision
 * history are never mutated. Unresolved patches are kept and stay
 * attributable; stale ones degrade to 'conflict' at accept time.
 */
export class RewindService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly conversations: ConversationService,
    private readonly revisions: RevisionService,
    private readonly checkpoints: CheckpointService,
    private readonly patches: PatchService,
  ) {}

  /** All rewind points for a conversation, newest first. */
  listPoints(conversationId: string, documentId?: string): RewindPoint[] {
    const points: RewindPoint[] = [];
    const turns = this.db
      .prepare(
        `SELECT id, conversation_id, status, started_at, ended_at,
                end_message_seq, end_revision, context_manifest_json
         FROM agent_runs
         WHERE conversation_id = ? AND parent_run_id IS NULL
           AND status != 'running' AND end_message_seq IS NOT NULL
         ORDER BY started_at`,
      )
      .all(conversationId) as unknown as TurnRow[];
    for (const turn of turns) {
      // Turns without a document context (e.g. profile-building runs) are
      // conversation history but not rewind points.
      if (!this.turnDocumentId(turn)) {
        continue;
      }
      points.push({
        kind: 'turn',
        id: turn.id,
        description: this.turnDescription(turn),
        createdAt: turn.ended_at ?? turn.started_at,
        documentId: this.turnDocumentId(turn),
        targetRevision: turn.end_revision,
        boundarySeq: turn.end_message_seq,
      });
    }
    if (documentId) {
      for (const checkpoint of this.checkpoints.list(documentId)) {
        points.push({
          kind: 'checkpoint',
          id: checkpoint.id,
          description: checkpoint.description
            ? `${checkpoint.name} — ${checkpoint.description}`
            : checkpoint.name,
          createdAt: checkpoint.createdAt,
          documentId: checkpoint.documentId,
          targetRevision: checkpoint.revisionSeq,
        });
      }
    }
    // newest first; sort is stable, so ascending + reverse also puts
    // later-inserted points first on identical timestamps
    return points.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).reverse();
  }

  /** Preview the boundary: both texts (the renderer diffs) + kept patches. */
  preview(conversationId: string, kind: RewindPoint['kind'], id: string): RewindPreview {
    const point = this.resolvePoint(conversationId, kind, id);
    const currentRevision = this.revisions.getCurrentRevision(point.documentId);
    const targetRevision = point.targetRevision ?? currentRevision;
    return {
      point,
      currentRevision,
      currentText: this.revisions.getTextAt(point.documentId, currentRevision),
      targetText: this.revisions.getTextAt(point.documentId, targetRevision),
      pendingPatches: this.pendingPatches(point.documentId),
    };
  }

  /**
   * Rewind: restore the document as a new revision (append-only; no-op when
   * the text already matches) and, for turn points, fork the conversation at
   * the message boundary. The fork becomes the conversation the UI opens.
   */
  apply(conversationId: string, kind: RewindPoint['kind'], id: string): RewindResult {
    const point = this.resolvePoint(conversationId, kind, id);
    let revisionSeq = this.revisions.getCurrentRevision(point.documentId);
    if (point.targetRevision !== null) {
      revisionSeq = this.revisions.restore(point.documentId, point.targetRevision);
    }
    const result: RewindResult = { documentId: point.documentId, revisionSeq };
    if (point.kind === 'turn' && point.boundarySeq !== undefined) {
      result.conversationId = this.conversations.forkConversation(
        conversationId,
        point.boundarySeq,
      );
    }
    return result;
  }

  private resolvePoint(
    conversationId: string,
    kind: RewindPoint['kind'],
    id: string,
  ): RewindPoint {
    if (kind === 'turn') {
      const turn = this.db
        .prepare(
          `SELECT id, conversation_id, status, started_at, ended_at,
                  end_message_seq, end_revision, context_manifest_json
           FROM agent_runs WHERE id = ? AND parent_run_id IS NULL`,
        )
        .get(id) as unknown as TurnRow | undefined;
      if (!turn || turn.conversation_id !== conversationId) {
        throw new Error(`unknown rewind turn: ${id}`);
      }
      if (turn.status === 'running' || turn.end_message_seq === null) {
        throw new Error(`turn ${id} has no completed boundary to rewind to`);
      }
      const documentId = this.turnDocumentId(turn);
      if (!documentId) {
        throw new Error(`turn ${id} has no document context to rewind`);
      }
      return {
        kind: 'turn',
        id: turn.id,
        description: this.turnDescription(turn),
        createdAt: turn.ended_at ?? turn.started_at,
        documentId,
        targetRevision: turn.end_revision,
        boundarySeq: turn.end_message_seq,
      };
    }
    const checkpoint = this.db
      .prepare(
        'SELECT id, document_id, revision_seq, name, description, created_at FROM checkpoints WHERE id = ?',
      )
      .get(id) as
      | {
          id: string;
          document_id: string;
          revision_seq: number;
          name: string;
          description: string;
          created_at: string;
        }
      | undefined;
    if (!checkpoint) {
      throw new Error(`unknown checkpoint: ${id}`);
    }
    return {
      kind: 'checkpoint',
      id: checkpoint.id,
      description: checkpoint.description
        ? `${checkpoint.name} — ${checkpoint.description}`
        : checkpoint.name,
      createdAt: checkpoint.created_at,
      documentId: checkpoint.document_id,
      targetRevision: checkpoint.revision_seq,
    };
  }

  /** Runs carry their document in the context manifest; '' when the run had
   * no document context (not a rewind point). */
  private turnDocumentId(turn: TurnRow): string {
    const manifest = turn.context_manifest_json
      ? (JSON.parse(turn.context_manifest_json) as { documentId?: string })
      : null;
    return manifest?.documentId ?? '';
  }

  /** A turn starts with a user message: the last user message at or before
   * the recorded end boundary is the one that opened this turn. */
  private turnDescription(turn: TurnRow): string {
    const row = this.db
      .prepare(
        `SELECT payload_json FROM messages
         WHERE conversation_id = ? AND role = 'user' AND seq <= ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(turn.conversation_id, turn.end_message_seq) as
      | { payload_json: string }
      | undefined;
    const text = row
      ? userText((JSON.parse(row.payload_json) as { content?: unknown }).content).trim()
      : '';
    const base = text || `turn ending at message ${turn.end_message_seq}`;
    const description =
      base.length > DESCRIPTION_MAX ? `${base.slice(0, DESCRIPTION_MAX)}…` : base;
    return turn.status === 'completed' ? description : `${description} (${turn.status})`;
  }

  private pendingPatches(documentId: string): RewindPendingPatch[] {
    return this.patches
      .list(documentId)
      .filter(
        (patch) =>
          patch.status === 'proposed' ||
          patch.status === 'partial' ||
          patch.status === 'conflict',
      )
      .map((patch) => ({ id: patch.id, title: patch.title, status: patch.status }));
  }
}
