import { useMemo, useState } from 'react';
import type {
  ReferenceCreateResult,
  ReferenceDraft,
  ReferenceKind,
} from '../../../shared/reference-types';

const TYPE_OPTIONS: Array<{ value: ReferenceKind; label: string }> = [
  { value: 'article-journal', label: 'Journal article' },
  { value: 'book', label: 'Book' },
  { value: 'chapter', label: 'Book chapter' },
  { value: 'paper-conference', label: 'Conference paper' },
  { value: 'thesis', label: 'Thesis' },
  { value: 'report', label: 'Report' },
  { value: 'webpage', label: 'Webpage' },
  { value: 'document', label: 'Other' },
];

const EMPTY_DRAFT: ReferenceDraft = {
  citationKey: '',
  type: 'article-journal',
  title: '',
  authors: '',
  year: '',
  doi: '',
  url: '',
};

function keyPart(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9]+/g, '')
    .toLocaleLowerCase();
}

function previewKey(draft: ReferenceDraft): string {
  const firstAuthor = draft.authors.split(/[;\n]+/)[0]?.trim() ?? '';
  const family = firstAuthor.includes(',')
    ? firstAuthor.split(',')[0]
    : firstAuthor.split(/\s+/).at(-1) ?? '';
  const author = keyPart(family);
  const year = /^\d{1,4}$/.test(draft.year.trim()) ? draft.year.trim() : '';
  const title = keyPart(
    draft.title.split(/\s+/).find((word) => word.length > 3) ?? '',
  );
  return `${author || title || 'ref'}${year}`;
}

export default function AddReferenceForm({
  onCreated,
  onBack,
}: {
  onCreated(result: ReferenceCreateResult): void;
  onBack(): void;
}) {
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [lookingUp, setLookingUp] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generatedKey = useMemo(() => previewKey(draft), [draft]);

  const update = <K extends keyof ReferenceDraft>(
    key: K,
    value: ReferenceDraft[K],
  ) => setDraft((current) => ({ ...current, [key]: value }));

  const lookup = async () => {
    setLookingUp(true);
    setError(null);
    setMessage(null);
    try {
      const found = await window.texeris.references.lookupDoi(draft.doi);
      setDraft(found);
      setMessage('Details found. Review them before adding the reference.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLookingUp(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      onCreated(await window.texeris.references.create(draft));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="reference-form"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') event.stopPropagation();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="reference-doi-row">
        <label>
          <span>DOI <small>optional</small></span>
          <input
            autoFocus
            value={draft.doi}
            placeholder="10.1000/example"
            onChange={(event) => update('doi', event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={lookingUp || !draft.doi.trim()}
          onClick={() => void lookup()}
        >
          {lookingUp ? 'Looking up…' : 'Find details'}
        </button>
      </div>
      {message && <p className="citation-report">{message}</p>}
      {error && <p className="citation-error">{error}</p>}

      <label>
        <span>Title</span>
        <input
          required
          value={draft.title}
          placeholder="Title of the work"
          onChange={(event) => update('title', event.target.value)}
        />
      </label>
      <label>
        <span>Authors <small>separate multiple authors with semicolons</small></span>
        <input
          value={draft.authors}
          placeholder="Ada Smith; Lin Jones"
          onChange={(event) => update('authors', event.target.value)}
        />
      </label>
      <div className="reference-form-row">
        <label>
          <span>Year</span>
          <input
            inputMode="numeric"
            value={draft.year}
            placeholder="2026"
            onChange={(event) => update('year', event.target.value)}
          />
        </label>
        <label>
          <span>Type</span>
          <select
            value={draft.type}
            onChange={(event) =>
              update('type', event.target.value as ReferenceKind)
            }
          >
            {TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <details>
        <summary>More details</summary>
        <div className="reference-form-more">
          <label>
            <span>URL <small>optional</small></span>
            <input
              type="url"
              value={draft.url}
              placeholder="https://…"
              onChange={(event) => update('url', event.target.value)}
            />
          </label>
          <label>
            <span>Citation key</span>
            <input
              value={draft.citationKey}
              placeholder={generatedKey}
              onChange={(event) => update('citationKey', event.target.value)}
            />
          </label>
        </div>
      </details>

      <p className="reference-key-preview">
        Will cite as <strong>@{draft.citationKey || generatedKey}</strong>
      </p>
      <footer>
        <button type="button" onClick={onBack}>Back</button>
        <button
          className="reference-save"
          type="submit"
          disabled={saving || !draft.title.trim()}
        >
          {saving ? 'Adding…' : 'Add and cite'}
        </button>
      </footer>
    </form>
  );
}
