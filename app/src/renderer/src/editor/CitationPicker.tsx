import { useEffect, useRef, useState } from 'react';
import type {
  ReferenceImportReport,
  ReferenceListItem,
} from '../../../shared/reference-types';

export default function CitationPicker({
  markdown,
  replacing = false,
  onInsert,
  onClose,
}: {
  markdown: string;
  replacing?: boolean;
  onInsert(key: string): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ReferenceListItem[]>([]);
  const [selected, setSelected] = useState(0);
  const [importing, setImporting] = useState(false);
  const [report, setReport] = useState<ReferenceImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = async (value: string) => {
    setItems(await window.texeris.references.search(value, 40));
    setSelected(0);
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh(query).catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
    }, query ? 120 : 0);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
    void window.texeris.references
      .audit(markdown)
      .then((audit) => setUnresolved(audit.unresolvedKeys))
      .catch(() => undefined);
  }, []);

  const importReferences = async () => {
    setImporting(true);
    setError(null);
    try {
      const next = await window.texeris.references.importDialog();
      if (next) {
        setReport(next);
        await refresh(query);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setImporting(false);
    }
  };

  const insert = (item = items[selected]) => {
    if (!item) return;
    onInsert(item.key);
    onClose();
  };

  return (
    <div className="citation-overlay" onMouseDown={onClose}>
      <section
        className="citation-picker"
        role="dialog"
        aria-modal="true"
        aria-label="Insert citation"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            setSelected((index) => Math.min(items.length - 1, index + 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setSelected((index) => Math.max(0, index - 1));
          } else if (event.key === 'Enter') {
            event.preventDefault();
            insert();
          }
        }}
      >
        <header>
          <div>
            <h2>{replacing ? 'Replace citation' : 'Insert citation'}</h2>
            <p>Search by author, title, year, or citation key.</p>
          </div>
          <button aria-label="Close citation picker" onClick={onClose}>×</button>
        </header>
        <div className="citation-search-row">
          <input
            ref={inputRef}
            value={query}
            placeholder="Search references…"
            aria-label="Search references"
            onChange={(event) => setQuery(event.target.value)}
          />
          <button disabled={importing} onClick={() => void importReferences()}>
            {importing ? 'Importing…' : 'Import…'}
          </button>
        </div>
        {report && (
          <p className="citation-report">
            Imported {report.imported} from {report.sourceName}
            {report.skipped ? ` · ${report.skipped} already present` : ''}
          </p>
        )}
        {report && (report.renamed.length > 0 || report.warnings.length > 0) && (
          <p className="citation-import-warning">
            {[
              ...report.renamed.map(
                ({ from, to }) => `Renamed @${from} to @${to}.`,
              ),
              ...report.warnings,
            ].join(' ')}
          </p>
        )}
        {error && <p className="citation-error">{error}</p>}
        {unresolved.length > 0 && (
          <p className="citation-unresolved">
            Missing from this project: {unresolved.map((key) => `@${key}`).join(', ')}
          </p>
        )}
        <div className="citation-results">
          {items.map((item, index) => (
            <button
              key={item.key}
              className={index === selected ? 'selected' : ''}
              onMouseEnter={() => setSelected(index)}
              onClick={() => insert(item)}
            >
              <span className="citation-result-main">
                <strong>{item.authors || 'Unknown author'}</strong>
                {item.year && <span>{item.year}</span>}
                <span className="citation-key">@{item.key}</span>
              </span>
              <span className="citation-result-title">{item.title}</span>
            </button>
          ))}
          {items.length === 0 && (
            <div className="citation-empty">
              {query ? 'No matching references.' : 'No references yet.'}
              <button onClick={() => void importReferences()}>Import a bibliography</button>
            </div>
          )}
        </div>
        <footer>
          <span>↑↓ choose · Enter insert · Esc close</span>
          <span>{items.length} reference{items.length === 1 ? '' : 's'}</span>
        </footer>
      </section>
    </div>
  );
}
