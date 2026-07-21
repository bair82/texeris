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

export interface SpellcheckView {
  enabled: boolean;
  language: string;
  availableLanguages: string[];
}

export type AppearanceTheme = 'dark' | 'light' | 'system';
export type AppearanceFont = 'serif' | 'sans' | 'mono';
export type AppearanceWidth = 'comfortable' | 'wide' | 'full';

export interface AppearanceConfig {
  theme: AppearanceTheme;
  fontFamily: AppearanceFont;
  /** Rendered-mode body font size in px. */
  fontSize: number;
  editorWidth: AppearanceWidth;
}

export type PatchStyleMode = 'off' | 'audit' | 'revise-once';

export interface WritingProfileView {
  enabled: boolean;
  activeProfileId: string | null;
  activatedAt: string | null;
  sourceProject: string | null;
}

export const AppearanceConfigSchema = Type.Object({
  theme: Type.Union([
    Type.Literal('dark'),
    Type.Literal('light'),
    Type.Literal('system'),
  ]),
  fontFamily: Type.Union([Type.Literal('serif'), Type.Literal('sans'), Type.Literal('mono')]),
  fontSize: Type.Number({ minimum: 12, maximum: 24 }),
  editorWidth: Type.Union([
    Type.Literal('comfortable'),
    Type.Literal('wide'),
    Type.Literal('full'),
  ]),
});

export const SetAppearanceRequestSchema = Type.Partial(AppearanceConfigSchema);
export type SetAppearanceRequest = Static<typeof SetAppearanceRequestSchema>;

export interface SettingsView {
  modes: {
    fast: { provider: string; model: string };
    deep: { provider: string; model: string };
  };
  providers: ProviderSettingsView[];
  encryptionAvailable: boolean;
  spellcheck: SpellcheckView;
  appearance: AppearanceConfig;
  patchStyleMode: PatchStyleMode;
  writingProfile: WritingProfileView;
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

export const SetSpellcheckRequestSchema = Type.Object({
  enabled: Type.Boolean(),
  language: Type.String(),
});
export type SetSpellcheckRequest = Static<typeof SetSpellcheckRequestSchema>;

export const SetPatchStyleModeRequestSchema = Type.Object({
  mode: Type.Union([
    Type.Literal('off'),
    Type.Literal('audit'),
    Type.Literal('revise-once'),
  ]),
});
export type SetPatchStyleModeRequest = Static<typeof SetPatchStyleModeRequestSchema>;

export const SettingsChannels = {
  get: 'texeris:settings-get',
  setApiKey: 'texeris:settings-set-api-key',
  clearApiKey: 'texeris:settings-clear-api-key',
  setSpellcheck: 'texeris:settings-set-spellcheck',
  setAppearance: 'texeris:settings-set-appearance',
  setPatchStyleMode: 'texeris:settings-set-patch-style-mode',
  disableWritingProfile: 'texeris:settings-disable-writing-profile',
  /** main → renderer push: appearance changed, repaint now (EU6). */
  appearanceChanged: 'texeris:settings-appearance-changed',
} as const;
