import type { ContextActionEvent, ContextDescriptor } from '../../shared/context-menu-types';
import { getEditorCommands } from './editor/editorBridge';

type Handler = (event: ContextActionEvent) => boolean;
const handlers = new Set<Handler>();

export function registerContextActionHandler(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export function dispatchContextAction(event: ContextActionEvent): void {
  for (const handler of handlers) if (handler(event)) return;
}

export function describeContextAt(x: number, y: number): ContextDescriptor {
  const element = document.elementFromPoint(x, y) as HTMLElement | null;
  const documentRow = element?.closest<HTMLElement>('[data-context-document-id]');
  if (documentRow) return {
    kind: 'document',
    documentId: documentRow.dataset.contextDocumentId ?? '',
    path: documentRow.dataset.contextDocumentPath ?? '',
    isMain: documentRow.dataset.contextDocumentMain === 'true',
  };
  const conversation = element?.closest<HTMLElement>('[data-context-conversation-id]');
  if (conversation) return {
    kind: 'conversation',
    conversationId: conversation.dataset.contextConversationId ?? '',
    active: conversation.dataset.contextConversationActive === 'true',
  };
  const message = element?.closest<HTMLElement>('[data-context-message-seq]');
  if (message) return {
    kind: 'message',
    seq: Number(message.dataset.contextMessageSeq),
    role:
      message.dataset.contextMessageRole === 'user' ||
      message.dataset.contextMessageRole === 'assistant'
        ? message.dataset.contextMessageRole
        : 'tool',
    editable: message.dataset.contextMessageEditable === 'true',
    regeneratable: message.dataset.contextMessageRegeneratable === 'true',
  };
  if (element?.closest('.editor-host')) {
    return getEditorCommands()?.contextAt(x, y) ?? { kind: 'generic' };
  }
  return { kind: 'generic' };
}

export function showContextMenu(
  context: ContextDescriptor,
  anchor: HTMLElement,
): void {
  const rect = anchor.getBoundingClientRect();
  void window.texeris.contextMenu.show(
    context,
    Math.round(rect.right),
    Math.round(rect.bottom),
  );
}
