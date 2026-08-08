import type {
  EditMessagePreview,
  ForkMessageResult,
} from '../../shared/chat-types';
import type { ConversationService } from './conversation';
import type { ProjectContext } from './project';

function changeCountAt(project: ProjectContext, documentId: string, revision: number): number {
  if (revision === 0) return 0;
  return (
    project.db
      .prepare(
        'SELECT COUNT(*) AS n FROM revision_changes WHERE document_id = ? AND seq = ?',
      )
      .get(documentId, revision) as { n: number }
  ).n;
}

/** Read-only preview for the inline Edit message warning and optional diff. */
export function previewMessageEdit(
  project: ProjectContext,
  conversations: ConversationService,
  conversationId: string,
  messageSeq: number,
): EditMessagePreview {
  const boundary = conversations.messageEditBoundary(conversationId, messageSeq);
  const { manifest, mode } = boundary.context;
  const doc = project.db
    .prepare('SELECT path, current_revision FROM documents WHERE id = ? AND trashed_at IS NULL')
    .get(manifest.documentId) as { path: string; current_revision: number } | undefined;
  if (!doc) throw new Error('the document used by this message is no longer available');

  const targetChangeCount =
    manifest.baseChangeCount ??
    changeCountAt(project, manifest.documentId, manifest.baseRevision);
  const targetText = project.revisions.getTextAtBoundary(
    manifest.documentId,
    manifest.baseRevision,
    targetChangeCount,
  );
  const currentText = project.revisions.getCurrentText(manifest.documentId);
  const pendingPatchCount = (
    project.db
      .prepare(
        `SELECT COUNT(*) AS n FROM patches
         WHERE status IN ('proposed', 'partial', 'conflict')
           AND json_extract(origin_json, '$.conversationId') = ?`,
      )
      .get(conversationId) as { n: number }
  ).n;

  return {
    conversationId,
    messageSeq,
    text: boundary.text,
    mode,
    scope: manifest.scope,
    documentId: manifest.documentId,
    documentPath: doc.path,
    targetRevision: manifest.baseRevision,
    targetChangeCount,
    currentRevision: doc.current_revision,
    boundaryExact: boundary.boundaryExact,
    documentChanged: currentText !== targetText,
    laterMessageCount: boundary.laterMessageCount,
    pendingPatchCount,
    currentText,
    targetText,
    archivePassageIds: manifest.archivePassageIds,
  };
}

/**
 * Create the transcript branch and restore its document boundary. If restore
 * fails, remove the just-created empty branch so the operation has no visible
 * half-state.
 */
export function forkMessage(
  project: ProjectContext,
  conversations: ConversationService,
  conversationId: string,
  messageSeq: number,
  reason: 'edit' | 'regenerate' = 'edit',
): ForkMessageResult {
  const preview = previewMessageEdit(
    project,
    conversations,
    conversationId,
    messageSeq,
  );
  const forkId = conversations.forkAtUserMessage(
    conversationId,
    messageSeq,
    reason,
  );
  try {
    const restoredRevision = project.revisions.restoreBoundary(
      preview.documentId,
      preview.targetRevision,
      preview.targetChangeCount,
      { conversationId: forkId },
    );
    return {
      originalConversationId: conversationId,
      conversationId: forkId,
      documentId: preview.documentId,
      restoredRevision,
      mode: preview.mode,
      scope: preview.scope,
      archivePassageIds: preview.archivePassageIds,
    };
  } catch (error) {
    conversations.deleteConversation(forkId);
    throw error;
  }
}
