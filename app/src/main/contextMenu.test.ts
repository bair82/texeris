import { describe, expect, it, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import type { WebContents } from 'electron';
import { ContextDescriptorSchema, ContextMenuChannels } from '../shared/context-menu-types';

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  clipboard: { writeText: vi.fn() },
  ipcMain: { handle: vi.fn() },
  session: { defaultSession: { addWordToSpellCheckerDictionary: vi.fn() } },
  shell: { openExternal: vi.fn() },
}));

import { contextMenuTemplate } from './contextMenu';

const mockSender = {
  send: vi.fn(), replaceMisspelling: vi.fn(), copyImageAt: vi.fn(),
};
const sender = mockSender as unknown as WebContents;

const native = {
  x: 10, y: 20, isEditable: true, selectionText: 'selected', linkURL: '',
  mediaType: 'none', misspelledWord: '', dictionarySuggestions: [],
  editFlags: {
    canUndo: true, canRedo: false, canCut: true, canCopy: true,
    canPaste: true, canDelete: true, canSelectAll: true,
  },
};

const labels = (items: ReturnType<typeof contextMenuTemplate>) =>
  items.map((item) => item.label).filter(Boolean);

describe('native context menu model', () => {
  it('builds editor edit roles and image actions', () => {
    const menu = contextMenuTemplate(sender, {
      kind: 'editor', image: true, canUndo: true, canRedo: false,
    }, native as never);
    expect(labels(menu)).toEqual(expect.arrayContaining([
      'Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select All',
      'Copy Image', 'Edit Image Details…', 'Delete Image',
    ]));
    expect(menu.find((item) => item.label === 'Redo')?.enabled).toBe(false);
  });

  it('omits destructive/main actions for the main document', () => {
    const menu = contextMenuTemplate(sender, {
      kind: 'document', documentId: 'd1', path: 'paper.md', isMain: true,
    });
    expect(labels(menu)).toEqual(['Open', 'Rename…', 'Duplicate', 'Export…', 'Reveal in Files']);
  });

  it('includes document management for a secondary document', () => {
    const context = {
      kind: 'document', documentId: 'd2', path: 'notes.md', isMain: false,
    } as const;
    const menu = contextMenuTemplate(sender, {
      ...context,
    });
    expect(labels(menu)).toEqual(expect.arrayContaining([
      'Export…', 'Set as Main Document', 'Move to Trash…',
    ]));
    menu.find((item) => item.label === 'Export…')?.click?.(undefined as never, undefined as never, undefined as never);
    expect(mockSender.send).toHaveBeenCalledWith(ContextMenuChannels.action, {
      action: 'document:export', context,
    });
    mockSender.send.mockClear();
    menu.find((item) => item.label === 'Rename…')?.click?.(undefined as never, undefined as never, undefined as never);
    expect(mockSender.send).toHaveBeenCalledWith(ContextMenuChannels.action, {
      action: 'document:rename', context,
    });
  });

  it('offers safe links and ignores arbitrary protocols', () => {
    const safe = contextMenuTemplate(sender, { kind: 'generic' }, {
      ...native, isEditable: false, selectionText: '', linkURL: 'https://example.test',
    } as never);
    const unsafe = contextMenuTemplate(sender, { kind: 'generic' }, {
      ...native, isEditable: false, selectionText: '', linkURL: 'javascript:alert(1)',
    } as never);
    expect(labels(safe)).toContain('Open Link in Browser');
    expect(labels(unsafe)).not.toContain('Open Link in Browser');
  });

  it('places spelling suggestions before edit actions', () => {
    const menu = contextMenuTemplate(sender, { kind: 'generic' }, {
      ...native, misspelledWord: 'mispellled', dictionarySuggestions: ['misspelled'],
    } as never);
    expect(labels(menu).slice(0, 2)).toEqual(['misspelled', 'Add to Dictionary']);
    expect(menu.at(-1)?.type).not.toBe('separator');
  });

  it('validates every renderer context discriminator', () => {
    expect(Value.Check(ContextDescriptorSchema, { kind: 'message', seq: 4 })).toBe(true);
    expect(Value.Check(ContextDescriptorSchema, { kind: 'document', documentId: 'd' })).toBe(false);
  });
});
