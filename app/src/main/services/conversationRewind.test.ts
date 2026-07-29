import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { TurnContext } from '../../shared/chat-types';
import { ConversationService } from './conversation';
import { forkMessage, previewMessageEdit } from './conversationRewind';
import { createProject, ensureDocument, type ProjectContext } from './project';

describe('edit-message conversation rewind', () => {
  let root: string;
  let project: ProjectContext;
  let conversations: ConversationService;
  let documentId: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-rewind-'));
    project = createProject(root);
    conversations = new ConversationService(project.db);
    documentId = ensureDocument(project, 'manuscript.md');
  });

  afterEach(() => {
    project.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const userMessage = (text: string): AgentMessage => ({
    role: 'user',
    content: text,
    timestamp: Date.now(),
  });

  it('forks before the edited message and restores its exact document boundary', () => {
    project.revisions.commit(
      documentId,
      [{ from: 0, to: 0, deletedText: '', insertedText: 'hello' }],
      { actor: 'user', source: { kind: 'typing' } },
    );
    const context: TurnContext = {
      runId: 'run-1',
      mode: 'fast',
      manifest: {
        scope: { kind: 'document', documentId },
        documentId,
        items: [{ label: 'manuscript.md (document)', chars: 5 }],
        baseRevision: 1,
        baseChangeCount: 1,
        truncated: false,
        notices: [],
      },
    };
    const originalId = conversations.startNewConversation();
    conversations.appendMessages(originalId, [userMessage('earlier question')], context);
    conversations.appendMessages(originalId, [userMessage('question to edit')], {
      ...context,
      runId: 'run-2',
      mode: 'deep',
    });

    // Later typing amends revision 1, but the target message saw change 1.
    project.revisions.commit(
      documentId,
      [{ from: 5, to: 5, deletedText: '', insertedText: ' future' }],
      { actor: 'user', source: { kind: 'typing' } },
    );
    project.db
      .prepare(
        `INSERT INTO patches
           (id, document_id, base_revision, origin_json, title, summary,
            status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?)`,
      )
      .run(
        'patch-later',
        documentId,
        1,
        JSON.stringify({ conversationId: originalId, agentRunId: 'run-2' }),
        'Pending edit',
        'Not copied to the branch',
        new Date().toISOString(),
      );

    const preview = previewMessageEdit(project, conversations, originalId, 2);
    expect(preview).toMatchObject({
      text: 'question to edit',
      mode: 'deep',
      targetRevision: 1,
      targetChangeCount: 1,
      currentRevision: 1,
      boundaryExact: true,
      documentChanged: true,
      laterMessageCount: 0,
      pendingPatchCount: 1,
      targetText: 'hello',
      currentText: 'hello future',
    });

    const result = forkMessage(project, conversations, originalId, 2);
    expect(result).toMatchObject({
      originalConversationId: originalId,
      documentId,
      mode: 'deep',
    });
    expect(result.conversationId).not.toBe(originalId);
    expect(project.revisions.getCurrentText(documentId)).toBe('hello');
    expect(project.revisions.getCurrentRevision(documentId)).toBe(2);
    expect(conversations.listUiMessages(originalId).map((message) => message.text))
      .toEqual(['earlier question', 'question to edit']);
    expect(conversations.listUiMessages(result.conversationId).map((message) => message.text))
      .toEqual(['earlier question']);
    expect(conversations.listConversations().find((item) => item.id === result.conversationId)?.title)
      .toContain('(edited)');
    expect(
      project.db
        .prepare('SELECT COUNT(*) AS n FROM patches WHERE id = ?')
        .get('patch-later'),
    ).toMatchObject({ n: 1 });
  });

  it('rejects messages without a safe turn boundary', () => {
    const conversationId = conversations.startNewConversation();
    conversations.appendMessages(conversationId, [userMessage('legacy')]);
    expect(() => conversations.messageEditBoundary(conversationId, 1))
      .toThrow(/predates exact edit boundaries/);
  });
});
