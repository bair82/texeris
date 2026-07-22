import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentRunRecord,
  ContextManifest,
  ContextScope,
  ConversationListItem,
  ModelMode,
  NormalizedAgentEvent,
  UiMessage,
  DelegationRecord,
} from '../../shared/chat-types';
import type { HeadingInfo } from '../../shared/doc-types';
import { getEditorSelection, registerChatCommands } from './editor/editorBridge';
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
  const bottomRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

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
      setConversationId(id);
      setMessages(await window.texeris.chat.listMessages(id));
      setRuns(await window.texeris.chat.listRuns(id));
      setDelegations(await window.texeris.chat.listDelegations(id));
      setManifest(null);
      setError(null);
      setStreaming(null);
      onConversationChange?.(id);
    },
    [conversationId, onConversationChange],
  );

  const newConversation = useCallback(async () => {
    const { conversationId: id } = await window.texeris.chat.newConversation();
    setConversationId(id);
    setMessages([]);
    setRuns([]);
    setDelegations([]);
    setManifest(null);
    setError(null);
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
    return false;
  }), [conversations, messages, switchConversation]);

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
        if (conversationId) {
          void window.texeris.chat.listMessages(conversationId).then(setMessages);
          void window.texeris.chat.listRuns(conversationId).then(setRuns);
          void window.texeris.chat.listDelegations(conversationId).then(setDelegations);
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
    async (turn: LastTurn) => {
      if (!conversationId || streaming) {
        return;
      }
      try {
        setHeadings(await window.texeris.doc.outline());
        // Echo the user's message immediately — the run may take a while.
        setMessages((m) => [...m, { seq: -Date.now(), role: 'user', text: turn.text }]);
        await window.texeris.chat.startTurn({ conversationId, ...turn });
        setLastTurn(turn);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [conversationId, documentId, streaming],
  );

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

  return (
    <section className="chat">
      <header className="chat-controls">
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
        {manifest && (
          <span className="manifest-chip" title={manifest.notices.join('\n')}>
            {manifest.scope.kind} · rev {manifest.baseRevision} ·{' '}
            {manifest.items.reduce((n, i) => n + i.chars, 0)} chars
            {manifest.truncated ? ' · truncated' : ''}
          </span>
        )}
        <div className="conv-picker-wrap" ref={pickerRef}>
          <button
            className="usage-toggle conv-toggle"
            title="Conversations"
            onClick={() => {
              setPickerOpen((v) => !v);
              if (!pickerOpen) {
                void refreshConversations();
              }
            }}
          >
            {conversations.find((c) => c.id === conversationId)?.title ?? 'Chats'} ▾
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
          className="usage-toggle"
          title="Start a fresh conversation (the old one stays in history storage)"
          onClick={() => {
            void newConversation();
          }}
        >
          new chat
        </button>
        <button
          className="usage-toggle"
          title="Usage records"
          onClick={() => setShowUsage((v) => !v)}
        >
          usage
        </button>
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
            className={`msg msg-${m.role}`}
            data-context-message-seq={m.seq}
          >
            {m.role === 'tool' ? (
              <span className="tool-chip">
                {m.isError ? '⚠' : '⚙'} {m.toolName}
              </span>
            ) : (
              <>
                <MarkdownView text={m.text} />
                <button
                  className="msg-copy"
                  title="Copy message text"
                  onClick={() => {
                    void navigator.clipboard.writeText(m.text);
                    setCopiedSeq(m.seq);
                    setTimeout(
                      () => setCopiedSeq((s) => (s === m.seq ? null : s)),
                      1200,
                    );
                  }}
                >
                  {copiedSeq === m.seq ? 'copied' : 'copy'}
                </button>
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
