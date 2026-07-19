import { Type, type Static } from '@sinclair/typebox';

/**
 * Settings IPC contract: workspace config (model modes) + per-provider API
 * keys (plan §4.6). Keys are write-only over IPC — the renderer learns only
 * whether a key is set and from where, never the key itself.
 */

export interface ProviderSettingsView {
  id: string;
  label: string;
  keySource: 'keychain' | 'env' | 'none';
}

export interface SettingsView {
  modes: {
    fast: { provider: string; model: string };
    deep: { provider: string; model: string };
  };
  providers: ProviderSettingsView[];
  encryptionAvailable: boolean;
}

export const SetApiKeyRequestSchema = Type.Object({
  provider: Type.String(),
  key: Type.String(),
});
export type SetApiKeyRequest = Static<typeof SetApiKeyRequestSchema>;

export const ClearApiKeyRequestSchema = Type.Object({
  provider: Type.String(),
});
export type ClearApiKeyRequest = Static<typeof ClearApiKeyRequestSchema>;

export const SettingsChannels = {
  get: 'texeris:settings-get',
  setApiKey: 'texeris:settings-set-api-key',
  clearApiKey: 'texeris:settings-clear-api-key',
} as const;
