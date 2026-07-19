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
