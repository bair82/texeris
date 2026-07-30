import { useEffect, useState } from 'react';
import {
  BUILTIN_CITATION_STYLES,
  type CitationStyleId,
  type CitationStyleSettings,
} from '../../../shared/citation-style-types';

export default function ExportDialog({
  documentTitle,
  onExport,
  onClose,
}: {
  documentTitle: string;
  onExport: (style: CitationStyleId) => Promise<void>;
  onClose: () => void;
}) {
  const [settings, setSettings] = useState<CitationStyleSettings | null>(null);
  const [selected, setSelected] = useState<CitationStyleId>('chicago-author-date');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.texeris.doc.exportSettings().then((current) => {
      setSettings(current);
      setSelected(current.id);
    }).catch((reason) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [busy, onClose]);

  const chooseCustom = async () => {
    setError(null);
    try {
      const chosen = await window.texeris.doc.chooseCitationStyle();
      if (chosen) {
        setSettings(chosen);
        setSelected('custom');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onExport(selected);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  return (
    <div className="settings-overlay" onMouseDown={() => !busy && onClose()}>
      <section
        className="export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2 id="export-dialog-title">Export {documentTitle}</h2>
            <p>Choose how citations and the bibliography should appear.</p>
          </div>
          <button type="button" aria-label="Close export dialog" onClick={onClose} disabled={busy}>
            ×
          </button>
        </header>

        <label className="export-style-field">
          Citation style
          <select
            value={selected}
            onChange={(event) => setSelected(event.target.value as CitationStyleId)}
            disabled={!settings || busy}
            autoFocus
          >
            {BUILTIN_CITATION_STYLES.map((style) => (
              <option key={style.id} value={style.id}>{style.label}</option>
            ))}
            {settings?.customAvailable && (
              <option value="custom">{settings.customLabel ?? 'Custom CSL style'}</option>
            )}
          </select>
        </label>

        <button
          type="button"
          className="export-custom-style"
          onClick={() => void chooseCustom()}
          disabled={busy}
        >
          Choose CSL file…
        </button>

        <p className="export-hint">
          Remembered for this project. Applied to PDF, Word, ODT, and RTF;
          Markdown remains unchanged.
        </p>
        {error && <p className="export-error" role="alert">{error}</p>}

        <footer>
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="primary"
            onClick={() => void submit()}
            disabled={!settings || busy}
          >
            {busy ? 'Exporting…' : 'Continue…'}
          </button>
        </footer>
      </section>
    </div>
  );
}
