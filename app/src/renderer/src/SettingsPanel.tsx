import { useCallback, useEffect, useState } from 'react';
import type { SettingsView } from '../../shared/settings-types';

/**
 * Settings panel: model modes (from config.json) and per-provider API keys.
 * Keys are stored encrypted via the OS keychain (safeStorage); the renderer
 * only ever sees the key source, never the key.
 */
export default function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [draftKeys, setDraftKeys] = useState<Record<string, string>>({});
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setSettings(await window.texeris.settings.get());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async (provider: string) => {
    await window.texeris.settings.setApiKey(provider, draftKeys[provider] ?? '');
    setDraftKeys((d) => ({ ...d, [provider]: '' }));
    setSavedNote(`saved key for ${provider}`);
    setTimeout(() => setSavedNote(null), 2500);
    await refresh();
  };

  const clear = async (provider: string) => {
    await window.texeris.settings.clearApiKey(provider);
    await refresh();
  };

  if (!settings) {
    return null;
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Settings</h2>
          <button onClick={onClose}>✕</button>
        </header>

        <h3>Model modes</h3>
        <p className="settings-hint">
          Edit <code>~/.config/texeris/config.json</code> to change them.
        </p>
        <dl className="settings-modes">
          <dt>Fast</dt>
          <dd>
            {settings.modes.fast.provider} / {settings.modes.fast.model}
          </dd>
          <dt>Deep</dt>
          <dd>
            {settings.modes.deep.provider} / {settings.modes.deep.model}
          </dd>
        </dl>

        <h3>Spellcheck</h3>
        <div className="settings-spellcheck">
          <label className="settings-check">
            <input
              type="checkbox"
              checked={settings.spellcheck.enabled}
              onChange={(e) => {
                void window.texeris.settings
                  .setSpellcheck({
                    enabled: e.target.checked,
                    language: settings.spellcheck.language,
                  })
                  .then(refresh);
              }}
            />
            Enable spellcheck
          </label>
          <select
            className="scope-select"
            disabled={!settings.spellcheck.enabled}
            value={settings.spellcheck.language}
            onChange={(e) => {
              void window.texeris.settings
                .setSpellcheck({ enabled: true, language: e.target.value })
                .then(refresh);
            }}
          >
            {settings.spellcheck.availableLanguages.map((lang) => (
              <option key={lang} value={lang}>
                {lang}
              </option>
            ))}
          </select>
        </div>

        <h3>Appearance</h3>
        <div className="settings-appearance">
          <label>
            Theme
            <select
              className="scope-select"
              value={settings.appearance.theme}
              onChange={(e) => {
                void window.texeris.settings
                  .setAppearance({
                    theme: e.target.value as typeof settings.appearance.theme,
                  })
                  .then(refresh);
              }}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="system">System</option>
            </select>
          </label>
          <label>
            Editor font
            <select
              className="scope-select"
              value={settings.appearance.fontFamily}
              onChange={(e) => {
                void window.texeris.settings
                  .setAppearance({
                    fontFamily: e.target.value as typeof settings.appearance.fontFamily,
                  })
                  .then(refresh);
              }}
            >
              <option value="serif">Serif</option>
              <option value="sans">Sans</option>
              <option value="mono">Monospace</option>
            </select>
          </label>
          <label>
            Font size
            <select
              className="scope-select"
              value={String(settings.appearance.fontSize)}
              onChange={(e) => {
                void window.texeris.settings
                  .setAppearance({ fontSize: Number(e.target.value) })
                  .then(refresh);
              }}
            >
              {[14, 15, 16, 16.5, 17, 18, 20].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <label>
            Editor width
            <select
              className="scope-select"
              value={settings.appearance.editorWidth}
              onChange={(e) => {
                void window.texeris.settings
                  .setAppearance({
                    editorWidth: e.target.value as typeof settings.appearance.editorWidth,
                  })
                  .then(refresh);
              }}
            >
              <option value="comfortable">Comfortable</option>
              <option value="wide">Wide</option>
              <option value="full">Full</option>
            </select>
          </label>
        </div>

        <h3>Writing voice</h3>
        <div className="settings-writing-voice">
          <p className="settings-hint">
            {settings.writingProfile.enabled
              ? `Active profile ${settings.writingProfile.activeProfileId}`
              : 'No active writing profile. Build one from the command palette.'}
          </p>
          {settings.writingProfile.enabled && (
            <button onClick={() => void window.texeris.settings.disableWritingProfile().then(refresh)}>
              Disable profile
            </button>
          )}
          <label>
            Patch style review
            <select
              className="scope-select"
              value={settings.patchStyleMode}
              onChange={(event) => void window.texeris.settings
                .setPatchStyleMode(event.target.value as typeof settings.patchStyleMode)
                .then(refresh)}
            >
              <option value="off">Off</option>
              <option value="audit">Audit only</option>
              <option value="revise-once">Ask agent to revise once</option>
            </select>
          </label>
        </div>

        <h3>API keys</h3>
        {!settings.encryptionAvailable && (
          <p className="chat-error">
            OS keychain unavailable — keys will be stored weakly obfuscated.
          </p>
        )}
        {savedNote && <p className="settings-saved">{savedNote}</p>}
        {settings.providers.map((provider) => (
          <div key={provider.id} className="settings-provider">
            <label>
              {provider.label}
              <span className={`key-status key-${provider.keySource}`}>
                {provider.keySource === 'keychain'
                  ? 'stored in keychain'
                  : provider.keySource === 'env'
                    ? 'from environment'
                    : 'not set'}
              </span>
            </label>
            <div className="settings-key-row">
              <input
                type="password"
                placeholder={`${provider.label} API key`}
                value={draftKeys[provider.id] ?? ''}
                onChange={(e) =>
                  setDraftKeys((d) => ({ ...d, [provider.id]: e.target.value }))
                }
              />
              <button
                disabled={!(draftKeys[provider.id] ?? '').trim()}
                onClick={() => void save(provider.id)}
              >
                Save
              </button>
              {provider.keySource === 'keychain' && (
                <button onClick={() => void clear(provider.id)}>Clear</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
