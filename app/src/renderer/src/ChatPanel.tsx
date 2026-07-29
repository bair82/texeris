import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentRunRecord,
  ContextManifest,
  ContextScope,
  ConversationListItem,
  EditMessagePreview,
  ForkMessageResult,
  ModelMode,
  NormalizedAgentEvent,
  UiMessage,
  DelegationRecord,
} from '../../shared/chat-types';
import type { HeadingInfo } from '../../shared/doc-types';
import {
  getEditorCommands,
  getEditorSelection,
  registerChatCommands,
  reloadEditor,
} from './editor/editorBridge';
import { formatCompactDiff, lineDiff } from './editor/lib/diff';
import MarkdownView from './MarkdownView';
import { registerContextActionHandler, showContextMenu } from './contextMenuBridge';

interface StreamingState {
  runId: string;
  text: string;
  thinking: string;
  tools: Array<{ toolCallId: string; toolName: string; isError?: boolean }>;
  delegations: Array<{ id: string; role: string; status: string; summary: string }>;
}

interface LastTurn {
  text: string;
  mode: ModelMode;
  scope: ContextScope;
}

interface MessageEditState {
  seq: number;
  text: string;
  preview: EditMessagePreview;
  showDiff: boolean;
  submitting: boolean;
}

interface RegenerateState {
  assistantSeq: number;
  userSeq: number;
  text: string;
  preview: EditMessagePreview;
  showDiff: boolean;
  submitting: boolean;
}

function latestRegeneratableTurn(messages: UiMessage[]) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.seq < 1 || message.role === 'tool') continue;
    if (message.role !== 'assistant') return null;
    for (let j = i - 1; j >= 0; j -= 1) {
      const user = messages[j];
      if (user.seq > 0 && user.role === 'user') {
        return { assistantSeq: message.seq, user };
      }
    }
    return null;
  }
  return null;
}

function rewindDescription(preview: EditMessagePreview): string {
  if (!preview.documentChanged) {
    return `${preview.documentPath} already matches that turn`;
  }
  if (preview.currentRevision === preview.targetRevision) {
    return `restores ${preview.documentPath} to an earlier saved boundary within revision ${preview.targetRevision}`;
  }
  return `restores ${preview.documentPath} from revision ${preview.currentRevision} to its state at revision ${preview.targetRevision}`;
}

function MessageActionIcon({
  kind,
}: {
  kind: 'edit' | 'copy' | 'check' | 'regenerate';
}) {
  if (kind === 'edit') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M13.9 3.1a1.7 1.7 0 0 1 2.4 2.4L7.2 14.6l-3.3.8.8-3.3 9.2-9Z" />
      </svg>
    );
  }
  if (kind === 'check') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="m4 10.5 3.5 3.5L16 5.5" />
      </svg>
    );
  }
  if (kind === 'regenerate') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M15.5 7A6 6 0 1 0 16 12" />
        <path d="M12.5 3.5h3.5V7" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="6.5" y="6.5" width="9" height="9" rx="1.5" />
      <path d="M13.5 6.5v-2a1.5 1.5 0 0 0-1.5-1.5H4.5A1.5 1.5 0 0 0 3 4.5V12A1.5 1.5 0 0 0 4.5 13.5h2" />
    </svg>
  );
}

function ChatHeaderIcon({ kind }: { kind: 'new' | 'usage' }) {
  if (kind === 'new') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 4v12M4 10h12" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 15.5V11M8 15.5V7M12 15.5V9M16 15.5V4.5" />
    </svg>
  );
}

function conversationTitleParts(title: string): {
  title: string;
  branch: 'edited' | 'regenerated' | null;
} {
  const match = title.match(/^(.*) \((edited|regenerated)\)$/);
  return match
    ? {
        title: match[1],
        branch: match[2] as 'edited' | 'regenerated',
      }
    : { title, branch: null };
}

interface ChatPanelProps {
  /** Conversation to reopen at mount (persisted workspace state, EU1/EU3). */
  initialConversationId?: string | null;
  /** Report the active conversation so the shell can persist it. */
  onConversationChange?(conversationId: string): void;
  /** The document currently shown in the editor is the default chat target. */
  documentId: string | null;
  onOpenDocument?(documentId: string): void;
}

export default function ChatPanel({
  initialConversationId = null,
  onConversationChange,
  documentId,
  onOpenDocument,
}: ChatPanelProps) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [runs, setRuns] = useState<AgentRunRecord[]>([]);
  const [delegations, setDelegations] = useState<DelegationRecord[]>([]);
  const [showUsage, setShowUsage] = useState(false);
  const [headings, setHeadings] = useState<HeadingInfo[]>([]);
  const [mode, setMode] = useState<ModelMode>('fast');
  const [scope, setScope] = useState<ContextScope>({ kind: 'document' });
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState<StreamingState | null>(null);
  const [manifest, setManifest] = useState<ContextManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTurn, setLastTurn] = useState<LastTurn | null>(null);
  const [copiedSeq, setCopiedSeq] = useState<number | null>(null);
  const [messageEdit, setMessageEdit] = useState<MessageEditState | null>(null);
  const [regenerate, setRegenerate] = useState<RegenerateState | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const conversationIdRef = useRef<string | null>(null);

  const refreshConversations = useCallback(async () => {
    setConversations(await window.texeris.chat.listConversations());
  }, []);

  useEffect(() => {
    void (async () => {
      let id = initialConversationId;
      if (id) {
        const list = await window.texeris.chat.listConversations();
        setConversations(list);
        if (!list.some((c) => c.id === id)) {
          id = null;
        }
      } else {
        await refreshConversations();
      }
      if (!id) {
        ({ conversationId: id } = await window.texeris.chat.getOrCreateConversation());
      }
      conversationIdRef.current = id;
      setConversationId(id);
      setMessages(await window.texeris.chat.listMessages(id));
      setRuns(await window.texeris.chat.listRuns(id));
      setDelegations(await window.texeris.chat.listDelegations(id));
      setHeadings(await window.texeris.doc.outline(documentId ?? undefined));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the scope menu aligned with the document beside the chat panel.
  useEffect(() => {
    if (documentId) {
      void window.texeris.doc.outline(documentId).then(setHeadings);
    }
  }, [documentId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streaming]);

  // Close the picker on any outside click.
  useEffect(() => {
    if (!pickerOpen) {
      return;
    }
    const close = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) {
        setPickerOpen(false);
        setRenamingId(null);
        setConfirmDeleteId(null);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [pickerOpen]);

  const switchConversation = useCallback(
    async (id: string) => {
      if (id === conversationId) {
        return;
      }
      conversationIdRef.current = id;
      setConversationId(id);
      setMessages(await window.texeris.chat.listMessages(id));
      setRuns(await window.texeris.chat.listRuns(id));
      setDelegations(await window.texeris.chat.listDelegations(id));
      setManifest(null);
      setError(null);
      setStreaming(null);
      setMessageEdit(null);
      setRegenerate(null);
      onConversationChange?.(id);
    },
    [conversationId, onConversationChange],
  );

  const newConversation = useCallback(async () => {
    const { conversationId: id } = await window.texeris.chat.newConversation();
    conversationIdRef.current = id;
    setConversationId(id);
    setMessages([]);
    setRuns([]);
    setDelegations([]);
    setManifest(null);
    setError(null);
    setMessageEdit(null);
    setRegenerate(null);
    await refreshConversations();
    onConversationChange?.(id);
  }, [onConversationChange, refreshConversations]);

  // Command surface (EU5): the registry can start a fresh conversation.
  useEffect(() => {
    return registerChatCommands({
      newConversation: () => {
        void newConversation();
      },
      openConversation: (id) => {
        void switchConversation(id);
      },
    });
  }, [newConversation, switchConversation]);

  const submitRename = async () => {
    if (!renamingId) {
      return;
    }
    const title = renameText.trim();
    if (title) {
      await window.texeris.chat.renameConversation(renamingId, title);
      await refreshConversations();
    }
    setRenamingId(null);
  };

  const confirmDelete = async (id: string) => {
    setConfirmDeleteId(null);
    await window.texeris.chat.deleteConversation(id);
    await refreshConversations();
    if (id === conversationId) {
      await newConversation();
    }
  };

  const beginMessageEdit = useCallback(
    async (message: UiMessage) => {
      if (!conversationId || streaming || message.role !== 'user' || message.seq < 1) {
        return;
      }
      setError(null);
      try {
        await getEditorCommands()?.flush();
        const preview = await window.texeris.chat.previewMessageEdit(
          conversationId,
          message.seq,
        );
        setMessageEdit({
          seq: message.seq,
          text: message.text,
          preview,
          showDiff: false,
          submitting: false,
        });
        setRegenerate(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [conversationId, streaming],
  );

  const beginRegenerate = useCallback(
    async (assistantSeq: number) => {
      const turn = latestRegeneratableTurn(messages);
      if (
        !conversationId ||
        streaming ||
        !turn ||
        turn.assistantSeq !== assistantSeq
      ) {
        return;
      }
      setError(null);
      try {
        await getEditorCommands()?.flush();
        const preview = await window.texeris.chat.previewMessageEdit(
          conversationId,
          turn.user.seq,
        );
        setRegenerate({
          assistantSeq,
          userSeq: turn.user.seq,
          text: turn.user.text,
          preview,
          showDiff: false,
          submitting: false,
        });
        setMessageEdit(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [conversationId, messages, streaming],
  );

  useEffect(() => registerContextActionHandler((event) => {
    if (event.context.kind === 'conversation') {
      const context = event.context;
      const conversation = conversations.find((item) => item.id === context.conversationId);
      if (!conversation) return false;
      if (event.action === 'conversation:open') {
        void switchConversation(conversation.id); setPickerOpen(false);
      } else if (event.action === 'conversation:rename') {
        setPickerOpen(true); setRenamingId(conversation.id); setRenameText(conversation.title);
      } else if (event.action === 'conversation:delete') {
        setPickerOpen(true); setConfirmDeleteId(conversation.id);
      } else return false;
      return true;
    }
    if (event.context.kind === 'message' && event.action === 'message:copy') {
      const context = event.context;
      const message = messages.find((item) => item.seq === context.seq);
      if (!message) return false;
      void navigator.clipboard.writeText(message.text);
      setCopiedSeq(message.seq);
      setTimeout(() => setCopiedSeq((seq) => seq === message.seq ? null : seq), 1200);
      return true;
    }
    if (event.context.kind === 'message' && event.action === 'message:edit') {
      const context = event.context;
      const message = messages.find((item) => item.seq === context.seq);
      if (!message || message.role !== 'user') return false;
      void beginMessageEdit(message);
      return true;
    }
    if (event.context.kind === 'message' && event.action === 'message:regenerate') {
      void beginRegenerate(event.context.seq);
      return true;
    }
    return false;
  }), [
    beginMessageEdit,
    beginRegenerate,
    conversations,
    messages,
    switchConversation,
  ]);

  useEffect(() => {
    return window.texeris.chat.onEvent((event: NormalizedAgentEvent) => {
      if (event.type === 'run_start') {
        setStreaming({ runId: event.runId, text: '', thinking: '', tools: [], delegations: [] });
        setError(null);
      } else if (event.type === 'text_delta') {
        setStreaming((s) => (s ? { ...s, text: s.text + event.delta } : s));
      } else if (event.type === 'thinking_delta') {
        setStreaming((s) => (s ? { ...s, thinking: s.thinking + event.delta } : s));
      } else if (event.type === 'tool_start') {
        setStreaming((s) =>
          s ? { ...s, tools: [...s.tools, { toolCallId: event.toolCallId, toolName: event.toolName }] } : s,
        );
      } else if (event.type === 'tool_end') {
        setStreaming((s) =>
          s
            ? {
                ...s,
                tools: s.tools.map((t) =>
                  t.toolCallId === event.toolCallId ? { ...t, isError: event.isError } : t,
                ),
              }
            : s,
        );
      } else if (event.type === 'run_end') {
        setManifest(event.manifest);
        if (event.status === 'error') {
          setError(event.errorMessage ?? 'unknown error');
        }
        setStreaming(null);
        const activeConversationId = conversationIdRef.current;
        if (activeConversationId) {
          void window.texeris.chat.listMessages(activeConversationId).then(setMessages);
          void window.texeris.chat.listRuns(activeConversationId).then(setRuns);
          void window.texeris.chat.listDelegations(activeConversationId).then(setDelegations);
        }
      } else if (event.type === 'delegation_start' || event.type === 'delegation_end') {
        setStreaming((s) => {
          if (!s || s.runId !== event.runId) return s;
          const next = { id: event.delegationId, role: event.role, status: event.status, summary: event.summary };
          const found = s.delegations.some((d) => d.id === event.delegationId);
          return { ...s, delegations: found ? s.delegations.map((d) => d.id === next.id ? next : d) : [...s.delegations, next] };
        });
      } else if (event.type === 'profile_artifacts_created') {
        onOpenDocument?.(event.writingProfileDocumentId);
      }
    });
  }, [conversationId, onOpenDocument]);

  const startTurn = useCallback(
    async (
      turn: LastTurn,
      targetConversationId = conversationId,
      targetDocumentId = documentId,
    ) => {
      if (!targetConversationId || streaming) {
        return;
      }
      try {
        setHeadings(await window.texeris.doc.outline(targetDocumentId ?? undefined));
        // Echo the user's message immediately — the run may take a while.
        setMessages((m) => [...m, { seq: -Date.now(), role: 'user', text: turn.text }]);
        await window.texeris.chat.startTurn({
          conversationId: targetConversationId,
          ...turn,
        });
        setLastTurn(turn);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [conversationId, documentId, streaming],
  );

  const continueFromFork = useCallback(
    async (result: ForkMessageResult, text: string) => {
      conversationIdRef.current = result.conversationId;
      setConversationId(result.conversationId);
      setMessages(await window.texeris.chat.listMessages(result.conversationId));
      setRuns([]);
      setDelegations([]);
      setManifest(null);
      setMode(result.mode);
      setScope(result.scope);
      setMessageEdit(null);
      setRegenerate(null);
      onConversationChange?.(result.conversationId);
      if (result.documentId === documentId) {
        reloadEditor();
      } else {
        onOpenDocument?.(result.documentId);
      }
      await refreshConversations();
      await startTurn(
        { text, mode: result.mode, scope: result.scope },
        result.conversationId,
        result.documentId,
      );
    },
    [
      documentId,
      onConversationChange,
      onOpenDocument,
      refreshConversations,
      startTurn,
    ],
  );

  const resendEditedMessage = useCallback(async () => {
    if (!messageEdit || !conversationId || streaming) return;
    const text = messageEdit.text.trim();
    if (!text) return;
    setMessageEdit((current) =>
      current ? { ...current, submitting: true } : current,
    );
    setError(null);
    try {
      await getEditorCommands()?.flush();
      const result = await window.texeris.chat.forkMessage(
        conversationId,
        messageEdit.seq,
        'edit',
      );
      await continueFromFork(result, text);
    } catch (err) {
      setMessageEdit((current) =>
        current ? { ...current, submitting: false } : current,
      );
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [
    conversationId,
    continueFromFork,
    messageEdit,
    streaming,
  ]);

  const regenerateLastResponse = useCallback(async () => {
    if (!regenerate || !conversationId || streaming) return;
    setRegenerate((current) =>
      current ? { ...current, submitting: true } : current,
    );
    setError(null);
    try {
      await getEditorCommands()?.flush();
      const result = await window.texeris.chat.forkMessage(
        conversationId,
        regenerate.userSeq,
        'regenerate',
      );
      await continueFromFork(result, regenerate.text);
    } catch (err) {
      setRegenerate((current) =>
        current ? { ...current, submitting: false } : current,
      );
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [conversationId, continueFromFork, regenerate, streaming]);

  const send = useCallback(async () => {
    if (!input.trim()) {
      return;
    }
    let effectiveScope = scope;
    if (scope.kind === 'selection') {
      const selection = getEditorSelection();
      if (!selection) {
        setError('no active editor selection — select some text first');
        return;
      }
      effectiveScope = { kind: 'selection', documentId: documentId ?? undefined, ...selection };
    }
    const text = input.trim();
    setInput('');
    await startTurn({
      text,
      mode,
      scope: { ...effectiveScope, documentId: documentId ?? undefined },
    });
  }, [documentId, input, mode, scope, startTurn]);

  const cancel = useCallback(() => {
    if (streaming) {
      void window.texeris.chat.cancel(streaming.runId);
    }
  }, [streaming]);

  const regeneratableTurn = latestRegeneratableTurn(messages);
  const activeConversation = conversations.find((c) => c.id === conversationId);
  const activeTitle = conversationTitleParts(activeConversation?.title ?? 'Chats');

  return (
    <section className="chat">
      <header className="chat-header">
        <div className="chat-header-primary">
          <div className="conv-picker-wrap" ref={pickerRef}>
            <button
              className="conv-toggle"
              title="Conversations"
              onClick={() => {
                setPickerOpen((v) => !v);
                if (!pickerOpen) {
                  void refreshConversations();
                }
              }}
            >
              <span className="conv-toggle-title">{activeTitle.title}</span>
              {activeTitle.branch && (
                <span className="conv-branch">{activeTitle.branch}</span>
              )}
              <span className="conv-chevron" aria-hidden="true">⌄</span>
            </button>
            {pickerOpen && (
              <div className="conv-picker">
                <ul className="conv-list">
                  {conversations.map((c) => (
                    <li
                      key={c.id}
                      className={c.id === conversationId ? 'active' : ''}
                      data-context-conversation-id={c.id}
                      data-context-conversation-active={c.id === conversationId}
                    >
                      {renamingId === c.id ? (
                        <input
                          autoFocus
                          className="conv-rename-input"
                          value={renameText}
                          onChange={(e) => setRenameText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              void submitRename();
                            } else if (e.key === 'Escape') {
                              setRenamingId(null);
                            }
                          }}
                        />
                      ) : confirmDeleteId === c.id ? (
                        <span className="conv-confirm">
                          <span className="conv-confirm-text">Delete?</span>
                          <button className="conv-confirm-yes" onClick={() => void confirmDelete(c.id)}>
                            Delete
                          </button>
                          <button className="conv-confirm-no" onClick={() => setConfirmDeleteId(null)}>
                            Keep
                          </button>
                        </span>
                      ) : (
                        <>
                          <button
                            className="conv-open"
                            title={`${c.messageCount} message(s)`}
                            onClick={() => {
                              void switchConversation(c.id);
                              setPickerOpen(false);
                            }}
                          >
                            <span className="conv-title">{c.title}</span>
                            <span className="conv-meta">{c.messageCount} ✉</span>
                          </button>
                          <button
                            className="conv-row-action"
                            title="Conversation actions"
                            onClick={(event) => showContextMenu({
                              kind: 'conversation', conversationId: c.id, active: c.id === conversationId,
                            }, event.currentTarget)}
                          >
                            ⋯
                          </button>
                        </>
                      )}
                    </li>
                  ))}
                  {conversations.length === 0 && <li className="conv-empty">no conversations</li>}
                </ul>
              </div>
            )}
          </div>
          <button
            className="chat-header-icon"
            aria-label="New conversation"
            title="Start a new conversation"
            onClick={() => void newConversation()}
          >
            <ChatHeaderIcon kind="new" />
          </button>
          <button
            className={`chat-header-icon${showUsage ? ' active' : ''}`}
            aria-label="Usage records"
            aria-pressed={showUsage}
            title="Usage records"
            onClick={() => setShowUsage((v) => !v)}
          >
            <ChatHeaderIcon kind="usage" />
          </button>
        </div>
        <div className="chat-header-context">
          <div className="toggle-group" title="Model mode">
            {(['fast', 'deep'] as const).map((m) => (
              <button
                key={m}
                className={mode === m ? 'active' : ''}
                onClick={() => setMode(m)}
              >
                {m === 'fast' ? 'Fast' : 'Deep'}
              </button>
            ))}
          </div>
          <select
            className="scope-select"
            title="Context scope"
            value={scope.kind === 'section' ? `section:${scope.heading}` : scope.kind}
            onChange={(e) => {
              const value = e.target.value;
              setScope(
                value === 'document'
                  ? { kind: 'document' }
                  : value === 'selection'
                    ? { kind: 'selection', from: 0, to: 0 }
                    : { kind: 'section', heading: value.slice('section:'.length) },
              );
            }}
          >
            <option value="document">Document</option>
            <option value="selection">Selection</option>
            {headings.map((h) => (
              <option key={`${h.line}:${h.text}`} value={`section:${h.text}`}>
                {' '.repeat(h.level)}§ {h.text}
              </option>
            ))}
          </select>
        </div>
        {manifest && (
          <span className="manifest-chip" title={manifest.notices.join('\n')}>
            {manifest.scope.kind} · rev {manifest.baseRevision} ·{' '}
            {manifest.items.reduce((n, i) => n + i.chars, 0)} chars
            {manifest.truncated ? ' · truncated' : ''}
          </span>
        )}
      </header>

      {showUsage && (
        <div className="usage-panel">
          {runs.length === 0 && <p className="usage-empty">no runs yet</p>}
          {runs.slice(-10).reverse().map((run) => (
            <div key={run.id} className="usage-row" title={run.error ?? undefined}>
              <span className={`usage-status usage-${run.status}`}>{run.status}</span>
              <span>{run.modelMode}</span>
              <span>
                {run.usage
                  ? `${run.usage.input}→${run.usage.output} tok`
                  : '—'}
              </span>
              <span>
                {run.endedAt
                  ? `${((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000).toFixed(1)}s`
                  : '…'}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="chat-messages">
        {delegations.length > 0 && (
          <details className="delegation-card delegation-history">
            <summary>Delegated work ({delegations.length})</summary>
            {delegations.map((delegation) => (
              <details key={delegation.id}>
                <summary>
                  {delegation.status === 'completed' ? '✓' : delegation.status === 'running' ? '◌' : '⚠'}{' '}
                  {delegation.role} · {delegation.model}
                </summary>
                <p>{delegation.summary ?? delegation.task}</p>
              </details>
            ))}
          </details>
        )}
        {messages.map((m) => (
          <div
            key={m.seq}
            className={`msg msg-${m.role}${
              messageEdit?.seq === m.seq ? ' msg-editing' : ''
            }`}
            data-context-message-seq={m.seq}
            data-context-message-role={m.role}
            data-context-message-editable={
              m.role === 'user' && m.seq > 0 && !streaming
            }
            data-context-message-regeneratable={
              m.role === 'assistant' &&
              m.seq === regeneratableTurn?.assistantSeq &&
              !streaming
            }
          >
            {m.role === 'tool' ? (
              <span className="tool-chip">
                {m.isError ? '⚠' : '⚙'} {m.toolName}
              </span>
            ) : (
              <>
                <div className="msg-content">
                  {messageEdit?.seq === m.seq ? (
                    <div className="message-edit">
                    <textarea
                      autoFocus
                      rows={4}
                      value={messageEdit.text}
                      disabled={messageEdit.submitting}
                      onChange={(event) =>
                        setMessageEdit((current) =>
                          current
                            ? { ...current, text: event.target.value }
                            : current,
                        )
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') setMessageEdit(null);
                        if (
                          event.key === 'Enter' &&
                          (event.metaKey || event.ctrlKey)
                        ) {
                          void resendEditedMessage();
                        }
                      }}
                    />
                    <p className="message-edit-warning">
                      Resending creates a new conversation branch
                      {messageEdit.preview.documentChanged
                        ? messageEdit.preview.currentRevision ===
                          messageEdit.preview.targetRevision
                          ? ` and restores ${messageEdit.preview.documentPath} to an earlier saved boundary within revision ${messageEdit.preview.targetRevision}`
                          : ` and restores ${messageEdit.preview.documentPath} from revision ${messageEdit.preview.currentRevision} to its state at revision ${messageEdit.preview.targetRevision}`
                        : `; ${messageEdit.preview.documentPath} already matches this turn`}
                      . The original conversation remains available.
                    </p>
                    {!messageEdit.preview.boundaryExact && (
                      <p className="message-edit-note">
                        This older message has revision-level rather than
                        keystroke-level boundary data.
                      </p>
                    )}
                    {(messageEdit.preview.laterMessageCount > 0 ||
                      messageEdit.preview.pendingPatchCount > 0) && (
                      <p className="message-edit-note">
                        {messageEdit.preview.laterMessageCount > 0 &&
                          `${messageEdit.preview.laterMessageCount} later message(s) remain in the original. `}
                        {messageEdit.preview.pendingPatchCount > 0 &&
                          `${messageEdit.preview.pendingPatchCount} pending patch(es) remain attributed to it.`}
                      </p>
                    )}
                    {messageEdit.preview.documentChanged && (
                      <button
                        className="message-edit-preview"
                        onClick={() =>
                          setMessageEdit((current) =>
                            current
                              ? { ...current, showDiff: !current.showDiff }
                              : current,
                          )
                        }
                      >
                        {messageEdit.showDiff ? 'Hide changes' : 'Preview document changes'}
                      </button>
                    )}
                    {messageEdit.showDiff && (
                      <pre className="message-edit-diff">
                        {formatCompactDiff(
                          lineDiff(
                            messageEdit.preview.currentText,
                            messageEdit.preview.targetText,
                          ),
                        )}
                      </pre>
                    )}
                    <div className="message-edit-actions">
                      <button
                        disabled={messageEdit.submitting}
                        onClick={() => setMessageEdit(null)}
                      >
                        Cancel
                      </button>
                      <button
                        disabled={
                          messageEdit.submitting || !messageEdit.text.trim()
                        }
                        onClick={() => void resendEditedMessage()}
                      >
                        {messageEdit.submitting
                          ? 'Creating branch…'
                          : 'Save and resend'}
                      </button>
                    </div>
                    </div>
                  ) : (
                    <>
                      <MarkdownView text={m.text} />
                      {regenerate?.assistantSeq === m.seq && (
                        <div className="regenerate-confirm">
                          <p className="message-edit-warning">
                            Regenerating creates a new conversation branch
                            {regenerate.preview.documentChanged
                              ? ` and ${rewindDescription(regenerate.preview)}`
                              : `; ${regenerate.preview.documentPath} already matches that turn`}
                            . The original response remains available.
                          </p>
                          {regenerate.preview.pendingPatchCount > 0 && (
                            <p className="message-edit-note">
                              {regenerate.preview.pendingPatchCount} pending
                              patch(es) remain attributed to the original.
                            </p>
                          )}
                          {regenerate.preview.documentChanged && (
                            <button
                              className="message-edit-preview"
                              onClick={() =>
                                setRegenerate((current) =>
                                  current
                                    ? {
                                        ...current,
                                        showDiff: !current.showDiff,
                                      }
                                    : current,
                                )
                              }
                            >
                              {regenerate.showDiff
                                ? 'Hide changes'
                                : 'Preview document changes'}
                            </button>
                          )}
                          {regenerate.showDiff && (
                            <pre className="message-edit-diff">
                              {formatCompactDiff(
                                lineDiff(
                                  regenerate.preview.currentText,
                                  regenerate.preview.targetText,
                                ),
                              )}
                            </pre>
                          )}
                          <div className="message-edit-actions">
                            <button
                              disabled={regenerate.submitting}
                              onClick={() => setRegenerate(null)}
                            >
                              Cancel
                            </button>
                            <button
                              disabled={regenerate.submitting}
                              onClick={() => void regenerateLastResponse()}
                            >
                              {regenerate.submitting
                                ? 'Creating branch…'
                                : 'Regenerate'}
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
                {messageEdit?.seq !== m.seq && (
                  <span className="msg-actions" aria-label="Message actions">
                    {m.role === 'user' && m.seq > 0 && (
                      <button
                        type="button"
                        aria-label="Edit message"
                        title="Edit message and create a branch"
                        disabled={Boolean(streaming)}
                        onClick={() => void beginMessageEdit(m)}
                      >
                        <MessageActionIcon kind="edit" />
                      </button>
                    )}
                    {m.role === 'assistant' &&
                      m.seq === regeneratableTurn?.assistantSeq && (
                        <button
                          type="button"
                          aria-label="Regenerate response"
                          title="Regenerate response in a new branch"
                          disabled={Boolean(streaming)}
                          onClick={() => void beginRegenerate(m.seq)}
                        >
                          <MessageActionIcon kind="regenerate" />
                        </button>
                      )}
                    <button
                      type="button"
                      aria-label={copiedSeq === m.seq ? 'Copied' : 'Copy message'}
                      title={copiedSeq === m.seq ? 'Copied' : 'Copy message'}
                      onClick={() => {
                        void navigator.clipboard.writeText(m.text);
                        setCopiedSeq(m.seq);
                        setTimeout(
                          () => setCopiedSeq((s) => (s === m.seq ? null : s)),
                          1200,
                        );
                      }}
                    >
                      <MessageActionIcon
                        kind={copiedSeq === m.seq ? 'check' : 'copy'}
                      />
                    </button>
                  </span>
                )}
              </>
            )}
          </div>
        ))}
        {streaming && (
          <div className="msg msg-assistant streaming">
            {streaming.delegations.map((delegation) => (
              <details className="delegation-card" key={delegation.id}>
                <summary>{delegation.status === 'running' ? '◌' : delegation.status === 'completed' ? '✓' : '⚠'} {delegation.role}</summary>
                <p>{delegation.summary}</p>
              </details>
            ))}
            {streaming.thinking && (
              <details className="thinking">
                <summary>Reasoning</summary>
                <p>{streaming.thinking}</p>
              </details>
            )}
            {streaming.tools.map((t) => (
              <span key={t.toolCallId} className="tool-chip">
                {t.isError === undefined ? '…' : t.isError ? '⚠' : '⚙'} {t.toolName}
              </span>
            ))}
            <p>{streaming.text || ' '}</p>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && (
        <p className="chat-error">
          {error}
          {lastTurn && (
            <button
              className="retry-button"
              onClick={() => {
                setError(null);
                void startTurn(lastTurn);
              }}
            >
              Retry
            </button>
          )}
        </p>
      )}

      <footer className="chat-input">
        <textarea
          value={input}
          placeholder="Ask about the manuscript…"
          rows={3}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              void send();
            }
          }}
        />
        {streaming ? (
          <button onClick={cancel}>Cancel</button>
        ) : (
          <button onClick={() => void send()} disabled={!input.trim()}>
            Send ⌘⏎
          </button>
        )}
      </footer>
    </section>
  );
}
