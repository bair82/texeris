import { useEffect, useMemo, useRef, useState } from 'react';
import { COMMANDS, type CommandSpec } from '../../../shared/commands';

interface CommandPaletteProps {
  onRun(commandId: string): void;
  onClose(): void;
}

function matches(command: CommandSpec, query: string): boolean {
  const hay = `${command.section} ${command.title}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((token) => hay.includes(token));
}

/**
 * Ctrl+K command palette (M1.5 EU5): every command in the shared registry,
 * filtered by substring tokens, fully keyboard-driven (arrows, Enter, Esc).
 */
export default function CommandPalette({ onRun, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const filtered = useMemo(
    () => COMMANDS.filter((c) => matches(c, query)),
    [query],
  );
  const clamped = Math.min(selected, Math.max(0, filtered.length - 1));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    listRef.current
      ?.querySelector('.palette-row.active')
      ?.scrollIntoView({ block: 'nearest' });
  }, [clamped]);

  const run = (id: string) => {
    onClose();
    onRun(id);
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="command-palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Type a command…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSelected((s) => Math.min(s + 1, filtered.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSelected((s) => Math.max(s - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const command = filtered[clamped];
              if (command) {
                run(command.id);
              }
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <ul className="palette-list" ref={listRef}>
          {filtered.map((command, i) => (
            <li key={command.id}>
              <button
                className={`palette-row ${i === clamped ? 'active' : ''}`}
                onMouseEnter={() => setSelected(i)}
                onClick={() => run(command.id)}
              >
                <span className="palette-section">{command.section}</span>
                <span className="palette-title">{command.title}</span>
                <span className="palette-hint">
                  {command.shortcutHint ?? command.accelerator?.replace('CmdOrCtrl', 'Ctrl') ?? ''}
                </span>
              </button>
            </li>
          ))}
          {filtered.length === 0 && <li className="palette-empty">no matching commands</li>}
        </ul>
      </div>
    </div>
  );
}
