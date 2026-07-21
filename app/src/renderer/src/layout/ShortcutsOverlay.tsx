import { COMMANDS } from '../../../shared/commands';

/**
 * Shortcuts overlay (M1.5 EU5): every command and its shortcut, grouped by
 * menu section. Data comes from the same shared definitions as the menu
 * and the palette, so the three never drift.
 */
export default function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  const sections = [...new Set(COMMANDS.map((c) => c.section))];
  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel shortcuts-panel" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Keyboard shortcuts</h2>
          <button onClick={onClose}>✕</button>
        </header>
        {sections.map((section) => (
          <div key={section}>
            <h3>{section}</h3>
            <dl className="shortcuts-list">
              {COMMANDS.filter((c) => c.section === section).map((command) => (
                <div key={command.id} className="shortcuts-row">
                  <dt>{command.title}</dt>
                  <dd>
                    {command.shortcutHint ??
                      command.accelerator?.replace('CmdOrCtrl', 'Ctrl') ??
                      '—'}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
        <p className="settings-hint">
          The full command list is also in the palette (Ctrl+K) and the app
          menu (Alt to reveal).
        </p>
      </div>
    </div>
  );
}
