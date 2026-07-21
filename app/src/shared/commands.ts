/**
 * Command definitions (M1.5 EU5): the single source for the app menu
 * (main), the command palette and the shortcuts overlay (renderer). Actions
 * live in the renderer's registry; this file is data only.
 */

export interface CommandSpec {
  id: string;
  section: 'File' | 'Edit' | 'View' | 'Chat' | 'Help';
  title: string;
  /** Electron accelerator, when the command has one. */
  accelerator?: string;
  /** Shown in palette/overlay (defaults to accelerator). */
  shortcutHint?: string;
}

export const COMMANDS: readonly CommandSpec[] = [
  { id: 'file:new-document', section: 'File', title: 'New Document', accelerator: 'CmdOrCtrl+N' },
  { id: 'file:new-project', section: 'File', title: 'New Project…' },
  { id: 'file:import-document', section: 'File', title: 'Import Markdown File…' },
  { id: 'file:switch-project', section: 'File', title: 'Switch Project…', accelerator: 'CmdOrCtrl+O' },

  // undo/redo have no menu accelerator on purpose: the editors own
  // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y natively; a menu binding would preempt them.
  { id: 'edit:undo', section: 'Edit', title: 'Undo', shortcutHint: 'Ctrl+Z in editor' },
  { id: 'edit:redo', section: 'Edit', title: 'Redo', shortcutHint: 'Ctrl+Shift+Z in editor' },
  { id: 'edit:find', section: 'Edit', title: 'Find in Document', accelerator: 'CmdOrCtrl+F' },

  { id: 'view:command-palette', section: 'View', title: 'Command Palette', accelerator: 'CmdOrCtrl+K', shortcutHint: 'Ctrl+K / Ctrl+P' },
  { id: 'view:toggle-mode', section: 'View', title: 'Toggle Rendered / Raw', accelerator: 'CmdOrCtrl+E' },
  { id: 'view:toggle-nav', section: 'View', title: 'Toggle Files Panel' },
  { id: 'view:toggle-side', section: 'View', title: 'Toggle Assistant Panel' },
  { id: 'view:toggle-focus', section: 'View', title: 'Focus Mode' },
  { id: 'view:toggle-history', section: 'View', title: 'Revision History' },

  { id: 'chat:new', section: 'Chat', title: 'New Conversation' },

  { id: 'help:shortcuts', section: 'Help', title: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/' },
] as const;

export type CommandId = (typeof COMMANDS)[number]['id'];

/** main → renderer push channel carrying a command id from the app menu. */
export const MenuCommandChannel = 'texeris:menu-command';
