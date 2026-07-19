import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentRunRecord,
  ContextManifest,
  ContextScope,
  ModelMode,
  NormalizedAgentEvent,
  UiMessage,
} from '../../shared/chat-types';
import type { HeadingInfo } from '../../shared/doc-types';
import { getEditorSelection } from './editor/editorBridge';
import MarkdownView from './MarkdownView';

interface StreamingState {
  runId: string;
  text: string;
  thinking: string;
  tools: Array<{ toolCallId: string; toolName: string; isError?: boolean }>;
}

interface LastTurn {
  text: string;
  mode: ModelMode;
  scope: ContextScope;
}

export default function ChatPanel() {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [runs, setRuns] = useState<AgentRunRecord[]>([]);
  const [showUsage, setShowUsage] = useState(false);
  const [headings, setHeadings] = useState<HeadingInfo[]>([]);
  const [mode, setMode] = useState<ModelMode>('fast');
  const [scope, setScope] = useState<ContextScope>({ kind: 'document' });
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState<StreamingState | null>(null);
  const [manifest, setManifest] = useState<ContextManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTurn, setLastTurn] = useState<LastTurn | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void (async () => {
      const { conversationId: id } = await window.texeris.chat.getOrCreateConversation();
      setConversationId(id);
      setMessages(await window.texeris.chat.listMessages(id));
      setRuns(await window.texeris.chat.listRuns(id));
      setHeadings(await window.texeris.doc.outline());
    })();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streaming]);

  useEffect(() => {
    return window.texeris.chat.onEvent((event: NormalizedAgentEvent) => {
      if (event.type === 'run_start') {
        setStreaming({ runId: event.runId, text: '', thinking: '', tools: [] });
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
        }
      }
    });
  }, [conversationId]);

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
    [conversationId, streaming],
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
      effectiveScope = { kind: 'selection', ...selection };
    }
    const text = input.trim();
    setInput('');
    await startTurn({ text, mode, scope: effectiveScope });
  }, [input, mode, scope, startTurn]);

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
        {messages.map((m) => (
          <div key={m.seq} className={`msg msg-${m.role}`}>
            {m.role === 'tool' ? (
              <span className="tool-chip">
                {m.isError ? '⚠' : '⚙'} {m.toolName}
              </span>
            ) : (
              <MarkdownView text={m.text} />
            )}
          </div>
        ))}
        {streaming && (
          <div className="msg msg-assistant streaming">
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
