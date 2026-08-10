import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicWriteText } from './document';

/**
 * Workspace settings (plan §4.9): platform config dir holds config.json with
 * the Fast/Deep model modes. Project data never stores credentials — keys
 * come from env vars in development (plan §4.6).
 */

export interface ModelModeConfig {
  provider: string;
  model: string;
}

export interface SpellcheckConfig {
  enabled: boolean;
  language: string;
}

export interface WorkspaceConfig {
  modes: {
    fast: ModelModeConfig;
    deep: ModelModeConfig;
  };
  spellcheck: SpellcheckConfig;
  appearance: import('../../shared/settings-types').AppearanceConfig;
  patchStyleMode: import('../../shared/settings-types').PatchStyleMode;
  /** LLM-generated checkpoint descriptions (owner request 2026-08-08). */
  llmCheckpointDescriptions: boolean;
  activeProfileId: string | null;
}

export const DEFAULT_CONFIG: WorkspaceConfig = {
  modes: {
    fast: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    deep: { provider: 'moonshotai', model: 'kimi-k3' },
  },
  spellcheck: { enabled: false, language: 'en-US' },
  appearance: {
    theme: 'dark',
    fontFamily: 'serif',
    fontSize: 16.5,
    editorWidth: 'comfortable',
  },
  patchStyleMode: 'off',
  llmCheckpointDescriptions: true,
  activeProfileId: null,
};

export function workspaceDir(): string {
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(base, 'texeris');
}

export function configPath(dir = workspaceDir()): string {
  return path.join(dir, 'config.json');
}

/** Load config.json, creating it with defaults on first run. */
export function loadWorkspaceConfig(dir = workspaceDir()): WorkspaceConfig {
  const file = configPath(dir);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    atomicWriteText(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
    return DEFAULT_CONFIG;
  }
  let parsed: Partial<WorkspaceConfig>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<WorkspaceConfig>;
  } catch {
    // A hand-edited config should never stop the desktop app from opening.
    atomicWriteText(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
    return structuredClone(DEFAULT_CONFIG);
  }
  const mode = (value: unknown, fallback: ModelModeConfig): ModelModeConfig => {
    if (!value || typeof value !== 'object') return { ...fallback };
    const candidate = value as Partial<ModelModeConfig>;
    // faux is an in-process test provider, never a valid persisted choice.
    if (candidate.provider === 'faux' && candidate.model === 'faux-model') return { ...fallback };
    return typeof candidate.provider === 'string' && typeof candidate.model === 'string'
      ? { provider: candidate.provider, model: candidate.model }
      : { ...fallback };
  };
  const config: WorkspaceConfig = {
    modes: {
      fast: mode(parsed.modes?.fast, DEFAULT_CONFIG.modes.fast),
      deep: mode(parsed.modes?.deep, DEFAULT_CONFIG.modes.deep),
    },
    spellcheck: {
      enabled:
        typeof parsed.spellcheck?.enabled === 'boolean'
          ? parsed.spellcheck.enabled
          : DEFAULT_CONFIG.spellcheck.enabled,
      language:
        typeof parsed.spellcheck?.language === 'string'
          ? parsed.spellcheck.language
          : DEFAULT_CONFIG.spellcheck.language,
    },
    appearance: {
      theme:
        parsed.appearance?.theme === 'dark' || parsed.appearance?.theme === 'light' || parsed.appearance?.theme === 'system'
          ? parsed.appearance.theme
          : DEFAULT_CONFIG.appearance.theme,
      fontFamily:
        parsed.appearance?.fontFamily === 'serif' || parsed.appearance?.fontFamily === 'sans' || parsed.appearance?.fontFamily === 'mono'
          ? parsed.appearance.fontFamily
          : DEFAULT_CONFIG.appearance.fontFamily,
      fontSize:
        typeof parsed.appearance?.fontSize === 'number' && parsed.appearance.fontSize >= 12 && parsed.appearance.fontSize <= 24
          ? parsed.appearance.fontSize
          : DEFAULT_CONFIG.appearance.fontSize,
      editorWidth:
        parsed.appearance?.editorWidth === 'comfortable' || parsed.appearance?.editorWidth === 'wide' || parsed.appearance?.editorWidth === 'full'
          ? parsed.appearance.editorWidth
          : DEFAULT_CONFIG.appearance.editorWidth,
    },
    patchStyleMode:
      parsed.patchStyleMode === 'audit' || parsed.patchStyleMode === 'revise-once'
        ? parsed.patchStyleMode
        : 'off',
    llmCheckpointDescriptions:
      typeof parsed.llmCheckpointDescriptions === 'boolean'
        ? parsed.llmCheckpointDescriptions
        : DEFAULT_CONFIG.llmCheckpointDescriptions,
    activeProfileId:
      typeof parsed.activeProfileId === 'string' ? parsed.activeProfileId : null,
  };
  // Persist a repaired faux/invalid config so the next normal launch is safe too.
  if (JSON.stringify(parsed) !== JSON.stringify(config)) saveWorkspaceConfig(config, dir);
  return config;
}

/** Persist the full config back to config.json (spellcheck lives here). */
export function saveWorkspaceConfig(config: WorkspaceConfig, dir = workspaceDir()): void {
  atomicWriteText(configPath(dir), JSON.stringify(config, null, 2) + '\n');
}
