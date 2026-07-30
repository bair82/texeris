import { useCallback, useEffect, useState } from 'react';
import type {
  ArchiveAttachment,
  ArchiveImportReport,
  ArchivePreview,
  ArchiveSearchResult,
  ArchiveSourceView,
} from '../../../shared/archive-types';

interface ProfileResult {
  conversationId: string;
  runId: string;
  sourceCount: number;
  warnings: string[];
}

export default function ArchivePanel({
  width,
  attachedPassageIds,
  onAttach,
  onProfileStarted,
}: {
  width: number;
  attachedPassageIds: ReadonlySet<string>;
  onAttach(result: ArchiveAttachment): void;
  onProfileStarted(result: ProfileResult): void;
}) {
  const [sources, setSources] = useState<ArchiveSourceView[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ArchiveSearchResult[]>([]);
  const [preview, setPreview] = useState<ArchivePreview | null>(null);
  const [addMenu, setAddMenu] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<'import' | 'profile' | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setSources(await window.texeris.archive.list());
  }, []);

  useEffect(() => {
    void refresh().catch((reason) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [refresh]);

  useEffect(() => window.texeris.jobs.onEvent((event) => {
    if (event.op !== 'archive-import') return;
    if (event.status === 'progress' && event.progress) {
      setProgress(`Adding writing… ${event.progress.done}/${event.progress.total}`);
    } else if (event.status === 'started') {
      setProgress('Adding writing…');
    } else {
      setProgress(null);
    }
  }), []);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      void window.texeris.archive.search(trimmed).then((next) => {
        if (active) setResults(next);
      }).catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  const importWriting = async (source: 'files' | 'folder') => {
    setAddMenu(false);
    setBusy('import');
    setError(null);
    setReport(null);
    try {
      const result = await window.texeris.archive.importDialog(source);
      if (result) {
        setReport(importSummary(result));
        await refresh();
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const openPreview = async (sourceId: string, offset = 0) => {
    setError(null);
    try {
      setPreview(await window.texeris.archive.preview(sourceId, offset));
      setConfirmDelete(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const deletePreview = async () => {
    if (!preview) return;
    try {
      await window.texeris.archive.delete(preview.source.id);
      setSelected((current) => {
        const next = new Set(current);
        next.delete(preview.source.id);
        return next;
      });
      setPreview(null);
      setConfirmDelete(false);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const buildProfile = async () => {
    if (selected.size === 0) return;
    setBusy('profile');
    setError(null);
    try {
      onProfileStarted(await window.texeris.archive.buildProfile([...selected]));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  if (preview) {
    return (
      <aside className="archive-panel" style={{ width }}>
        <header className="archive-header">
          <button className="archive-back" onClick={() => setPreview(null)}>←</button>
          <span className="nav-title">Preview</span>
          <button
            className="archive-delete"
            title="Remove from archive"
            onClick={() => setConfirmDelete(true)}
          >
            ⌫
          </button>
        </header>
        <div className="archive-preview-meta">
          <strong>{preview.source.title}</strong>
          <span>{preview.source.format.toUpperCase()} · {formatSize(preview.source.size)}</span>
          <span title={preview.source.originalPath}>{preview.source.originalPath}</span>
          {preview.source.status !== 'current' && (
            <span className="archive-status-warning">
              Original file {preview.source.status === 'changed' ? 'has changed' : 'is unavailable'};
              this saved snapshot is unchanged.
            </span>
          )}
        </div>
        {confirmDelete && (
          <div className="archive-confirm">
            <span>Remove this work and its saved snapshot?</span>
            <button onClick={() => void deletePreview()}>Remove</button>
            <button onClick={() => setConfirmDelete(false)}>Keep</button>
          </div>
        )}
        <pre className="archive-preview-text">{preview.text}</pre>
        {preview.truncated && (
          <p className="archive-preview-note">
            Showing {preview.text.length.toLocaleString()} of{' '}
            {preview.totalChars.toLocaleString()} characters from this location.
          </p>
        )}
      </aside>
    );
  }

  return (
    <aside className="archive-panel" style={{ width }}>
      <header className="archive-header">
        <span className="nav-title">Writing archive</span>
        <span className="archive-add-wrap">
          <button
            className="nav-action"
            title="Add previous writing"
            onClick={() => setAddMenu((open) => !open)}
          >
            +
          </button>
          {addMenu && (
            <span className="archive-add-menu">
              <button onClick={() => void importWriting('files')}>Choose files…</button>
              <button onClick={() => void importWriting('folder')}>Choose folder…</button>
            </span>
          )}
        </span>
      </header>
      <div className="archive-search">
        <input
          type="search"
          placeholder="Search your writing"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {(progress || report || error) && (
        <p className={`archive-report${error ? ' error' : ''}`} onClick={() => {
          setReport(null);
          setError(null);
        }}>
          {error ?? progress ?? report}
        </p>
      )}

      {query.trim() ? (
        <div className="archive-results">
          {results.map((result) => (
            <article className="archive-result" key={result.passageId}>
              <button
                className="archive-result-main"
                onClick={() => void openPreview(result.sourceId, result.startOffset)}
              >
                <strong>{result.title}</strong>
                <span>
                  {result.heading ?? 'Untitled passage'}
                  {result.page ? ` · p. ${result.page}` : ''}
                </span>
                <p>{result.excerpt}</p>
              </button>
              <button
                className={attachedPassageIds.has(result.passageId) ? 'attached' : ''}
                disabled={
                  attachedPassageIds.has(result.passageId) ||
                  attachedPassageIds.size >= 12
                }
                onClick={() => onAttach(result)}
              >
                {attachedPassageIds.has(result.passageId)
                  ? 'Attached'
                  : attachedPassageIds.size >= 12
                    ? '12 attached'
                    : 'Use in chat'}
              </button>
            </article>
          ))}
          {results.length === 0 && (
            <p className="archive-empty">No matching passages.</p>
          )}
        </div>
      ) : sources.length ? (
        <>
          <div className="archive-sources">
            {sources.map((source) => (
              <article className="archive-source" key={source.id}>
                <label title="Include when building a writing profile">
                  <input
                    type="checkbox"
                    checked={selected.has(source.id)}
                    onChange={(event) => setSelected((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(source.id);
                      else next.delete(source.id);
                      return next;
                    })}
                  />
                </label>
                <button onClick={() => void openPreview(source.id)}>
                  <strong>{source.title}</strong>
                  <span>
                    {source.format.toUpperCase()} · {source.passageCount} passage(s)
                    {source.status !== 'current' ? ` · ${source.status}` : ''}
                  </span>
                </button>
              </article>
            ))}
          </div>
          <footer className="archive-profile">
            <button
              disabled={selected.size === 0 || busy !== null}
              onClick={() => void buildProfile()}
            >
              {busy === 'profile'
                ? 'Starting profile…'
                : `Build profile${selected.size ? ` from ${selected.size}` : ''}`}
            </button>
          </footer>
        </>
      ) : (
        <div className="archive-empty-state">
          <strong>Your previous writing, searchable.</strong>
          <p>Add papers, chapters, proposals, or other work. Texeris keeps a private local snapshot.</p>
          <button onClick={() => void importWriting('files')} disabled={busy !== null}>
            Choose files…
          </button>
          <button onClick={() => void importWriting('folder')} disabled={busy !== null}>
            Choose folder…
          </button>
        </div>
      )}
    </aside>
  );
}

function importSummary(report: ArchiveImportReport): string {
  const parts = [`Added ${report.imported}`];
  if (report.duplicates) parts.push(`${report.duplicates} already present`);
  if (report.skipped) parts.push(`${report.skipped} skipped`);
  return `${parts.join(' · ')}${report.warnings.length ? `. ${report.warnings.join(' ')}` : ''}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
