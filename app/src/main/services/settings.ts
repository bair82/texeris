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
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<WorkspaceConfig>;
  return {
    modes: {
      fast: parsed.modes?.fast ?? DEFAULT_CONFIG.modes.fast,
      deep: parsed.modes?.deep ?? DEFAULT_CONFIG.modes.deep,
    },
    spellcheck: {
      enabled: parsed.spellcheck?.enabled ?? DEFAULT_CONFIG.spellcheck.enabled,
      language: parsed.spellcheck?.language ?? DEFAULT_CONFIG.spellcheck.language,
    },
    appearance: {
      theme: parsed.appearance?.theme ?? DEFAULT_CONFIG.appearance.theme,
      fontFamily: parsed.appearance?.fontFamily ?? DEFAULT_CONFIG.appearance.fontFamily,
      fontSize: parsed.appearance?.fontSize ?? DEFAULT_CONFIG.appearance.fontSize,
      editorWidth: parsed.appearance?.editorWidth ?? DEFAULT_CONFIG.appearance.editorWidth,
    },
  };
}

/** Persist the full config back to config.json (spellcheck lives here). */
export function saveWorkspaceConfig(config: WorkspaceConfig, dir = workspaceDir()): void {
  atomicWriteText(configPath(dir), JSON.stringify(config, null, 2) + '\n');
}
