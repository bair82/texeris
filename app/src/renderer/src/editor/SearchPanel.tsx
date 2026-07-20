import { useEffect, useRef, useState } from 'react';
import type { EditorSession, SearchMatch } from './session';

interface SearchPanelProps {
  session: EditorSession;
  onClose(): void;
}

/**
 * Find & replace panel (M1.5 EU2): one UI over both editor modes — the
 * session owns searching, highlighting, and replacing (replacements are
 * ordinary editor transactions, so they commit through the normal path).
 * Matches re-scan periodically while the panel is open so they track edits.
 */
export default function SearchPanel({ session, onClose }: SearchPanelProps) {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [current, setCurrent] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Scan on query/case change and periodically (edits shift matches).
  useEffect(() => {
    const scan = () => {
      const found = session.search(query, caseSensitive);
      setMatches(found);
      setCurrent((c) => Math.min(c, Math.max(0, found.length - 1)));
      session.setSearchHighlights(found, found.length === 0 ? -1 : Math.min(current, found.length - 1));
    };
    scan();
    const timer = setInterval(scan, 400);
    return () => {
      clearInterval(timer);
      session.setSearchHighlights([], -1);
    };
    // `current` intentionally read inside scan without re-arming the interval
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, session]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const reveal = (index: number, list = matches) => {
    if (list.length === 0) {
      return;
    }
    const clamped = ((index % list.length) + list.length) % list.length;
    setCurrent(clamped);
    session.setSearchHighlights(list, clamped);
    session.revealMatch(list[clamped]);
  };

  const replaceCurrent = () => {
    if (matches.length === 0) {
      return;
    }
    session.replaceMatch(matches[current], replacement);
    // rescan immediately so indices stay valid
    const found = session.search(query, caseSensitive);
    setMatches(found);
    const next = Math.min(current, Math.max(0, found.length - 1));
    setCurrent(next);
    session.setSearchHighlights(found, found.length === 0 ? -1 : next);
    if (found.length > 0) {
      session.revealMatch(found[next]);
    }
  };

  const replaceAll = () => {
    if (matches.length === 0) {
      return;
    }
    session.replaceAll(matches, replacement);
    setMatches([]);
    setCurrent(0);
    session.setSearchHighlights([], -1);
  };

  return (
    <div className="search-panel" onKeyDown={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        className="search-input"
        placeholder="Find…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            reveal(e.shiftKey ? current - 1 : current + 1);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className="search-count">
        {query ? (matches.length === 0 ? 'no matches' : `${Math.min(current + 1, matches.length)}/${matches.length}`) : ''}
      </span>
      <button
        className={`search-toggle ${caseSensitive ? 'active' : ''}`}
        title="Match case"
        onClick={() => setCaseSensitive((v) => !v)}
      >
        Aa
      </button>
      <button className="search-nav" title="Previous (Shift+Enter)" onClick={() => reveal(current - 1)}>
        ↑
      </button>
      <button className="search-nav" title="Next (Enter)" onClick={() => reveal(current + 1)}>
        ↓
      </button>
      <input
        className="search-input search-replace"
        placeholder="Replace with…"
        value={replacement}
        onChange={(e) => setReplacement(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <button className="search-action" disabled={matches.length === 0} onClick={replaceCurrent}>
        Replace
      </button>
      <button className="search-action" disabled={matches.length === 0} onClick={replaceAll}>
        All
      </button>
      <button className="search-close" title="Close (Esc)" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
