import { useEffect, useMemo, useState } from 'react';
import type { ContextScope, ModelMode } from '../../../shared/chat-types';
import type { HeadingInfo } from '../../../shared/doc-types';
import type { SkillSummary } from '../../../shared/skill-types';

interface LaunchChoice {
  mode: ModelMode;
  optionId: string;
  scope: ContextScope;
}

export default function SkillLaunchDialog({
  skill,
  documentId,
  selection,
  headings,
  onLaunch,
  onClose,
}: {
  skill: SkillSummary;
  documentId: string;
  selection: { from: number; to: number } | null;
  headings: HeadingInfo[];
  onLaunch: (choice: LaunchChoice) => Promise<void>;
  onClose: () => void;
}) {
  const initialTarget = selection
    ? 'selection'
    : 'document';
  const [target, setTarget] = useState<ContextScope['kind']>(initialTarget);
  const [heading, setHeading] = useState(headings[0]?.text ?? '');
  const [optionId, setOptionId] = useState(skill.options[0]?.id ?? '');
  const [mode, setMode] = useState<ModelMode>(skill.defaultMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scope = useMemo<ContextScope>(() => {
    if (target === 'selection' && selection) {
      return { kind: 'selection', ...selection, documentId };
    }
    if (target === 'section') {
      return { kind: 'section', heading, documentId };
    }
    return { kind: 'document', documentId };
  }, [documentId, heading, selection, target]);

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

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onLaunch({ mode, optionId, scope });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  return (
    <div className="settings-overlay" onMouseDown={() => !busy && onClose()}>
      <section
        className="skill-launch-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-launch-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2 id="skill-launch-title">{skill.name}</h2>
            <p>{skill.description}</p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} disabled={busy}>×</button>
        </header>

        <label className="skill-launch-field">
          Review
          <select
            value={target}
            onChange={(event) => setTarget(event.target.value as ContextScope['kind'])}
            disabled={busy}
            autoFocus
          >
            {skill.supportsScopes.includes('selection') && (
              <option value="selection" disabled={!selection}>Selected text</option>
            )}
            {skill.supportsScopes.includes('section') && (
              <option value="section" disabled={!headings.length}>A section</option>
            )}
            {skill.supportsScopes.includes('document') && (
              <option value="document">Whole document</option>
            )}
          </select>
        </label>

        {target === 'section' && (
          <label className="skill-launch-field">
            Section
            <select
              value={heading}
              onChange={(event) => setHeading(event.target.value)}
              disabled={busy}
            >
              {headings.map((item, index) => (
                <option key={`${item.line}:${index}`} value={item.text}>
                  {'  '.repeat(Math.max(0, item.level - 1))}{item.text}
                </option>
              ))}
            </select>
          </label>
        )}

        <fieldset className="skill-focus-options" disabled={busy}>
          <legend>Approach</legend>
          {skill.options.map((option) => (
            <label key={option.id}>
              <input
                type="radio"
                name="skill-focus"
                value={option.id}
                checked={optionId === option.id}
                onChange={() => setOptionId(option.id)}
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
            </label>
          ))}
        </fieldset>

        <label className="skill-launch-field skill-mode-field">
          Model
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value as ModelMode)}
            disabled={busy}
          >
            <option value="fast">Fast</option>
            <option value="deep">Deep</option>
          </select>
        </label>

        <p className="skill-launch-hint">
          Texeris starts a dedicated conversation. Any suggested changes remain reviewable and
          are never applied automatically.
        </p>
        {error && <p className="skill-launch-error" role="alert">{error}</p>}

        <footer>
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="primary"
            onClick={() => void submit()}
            disabled={busy || !optionId || (target === 'section' && !heading)}
          >
            {busy ? 'Starting…' : 'Start review'}
          </button>
        </footer>
      </section>
    </div>
  );
}
