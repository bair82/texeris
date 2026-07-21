import type {
  AppearanceConfig,
  AppearanceFont,
  AppearanceWidth,
} from '../../shared/settings-types';

/**
 * Appearance prefs (M1.5 EU6): applied to the document root as a theme
 * attribute + CSS variables, so changes repaint instantly — no reload.
 * `system` follows the OS dark/light preference live.
 */

const FONT_STACKS: Record<AppearanceFont, string> = {
  serif: "'Iowan Old Style', 'Palatino Linotype', 'Noto Serif', 'Liberation Serif', Georgia, serif",
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  mono: "ui-monospace, 'Cascadia Code', Menlo, Consolas, 'Liberation Mono', monospace",
};

const MEASURES: Record<AppearanceWidth, string> = {
  comfortable: '720px',
  wide: '960px',
  full: 'none',
};

const lightMedia = window.matchMedia('(prefers-color-scheme: light)');
let current: AppearanceConfig | null = null;

export function applyAppearance(config: AppearanceConfig): void {
  current = config;
  const root = document.documentElement;
  root.dataset.theme =
    config.theme === 'system' ? (lightMedia.matches ? 'light' : 'dark') : config.theme;
  root.style.setProperty('--editor-font-family', FONT_STACKS[config.fontFamily]);
  root.style.setProperty('--editor-font-size', `${config.fontSize}px`);
  root.style.setProperty('--editor-measure', MEASURES[config.editorWidth]);
}

lightMedia.addEventListener('change', () => {
  if (current?.theme === 'system') {
    applyAppearance(current);
  }
});

/** Boot: apply the persisted prefs, then keep repainting on change. */
export async function initAppearance(): Promise<void> {
  const settings = await window.texeris.settings.get();
  applyAppearance(settings.appearance);
  window.texeris.settings.onAppearanceChanged(applyAppearance);
}
