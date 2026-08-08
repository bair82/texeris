import { randomUUID } from 'node:crypto';
import {
  BrowserWindow, Menu, clipboard, ipcMain, session, shell,
  type ContextMenuParams, type MenuItemConstructorOptions, type WebContents,
} from 'electron';
import { Value } from '@sinclair/typebox/value';
import {
  ContextDescribeReplySchema, ContextMenuChannels, ContextShowRequestSchema,
  type ContextAction, type ContextDescriptor,
} from '../shared/context-menu-types';

interface PendingContext { sender: WebContents; params: ContextMenuParams; timer: ReturnType<typeof setTimeout> }
const pending = new Map<string, PendingContext>();

function safeExternal(url: string): boolean {
  try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; }
}

function actionItem(
  sender: WebContents,
  context: ContextDescriptor,
  label: string,
  action: ContextAction,
  enabled = true,
): MenuItemConstructorOptions {
  return { label, enabled, click: () => sender.send(ContextMenuChannels.action, { action, context }) };
}

export function contextMenuTemplate(
  sender: WebContents,
  context: ContextDescriptor,
  params?: ContextMenuParams,
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  const separator = () => {
    if (items.length && items.at(-1)?.type !== 'separator') items.push({ type: 'separator' });
  };
  const flags = params?.editFlags;
  if (params?.misspelledWord) {
    for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
      items.push({ label: suggestion, click: () => sender.replaceMisspelling(suggestion) });
    }
    items.push({
      label: 'Add to Dictionary',
      click: () => session.defaultSession.addWordToSpellCheckerDictionary(params.misspelledWord),
    });
    separator();
  }

  if (context.kind === 'editor') {
    items.push(
      actionItem(sender, context, 'Undo', 'editor:undo', context.canUndo),
      actionItem(sender, context, 'Redo', 'editor:redo', context.canRedo),
    );
    separator();
  } else if (params?.isEditable) {
    items.push(
      { label: 'Undo', role: 'undo', enabled: flags?.canUndo },
      { label: 'Redo', role: 'redo', enabled: flags?.canRedo },
    );
    separator();
  }

  if (params?.isEditable) {
    items.push(
      { label: 'Cut', role: 'cut', enabled: flags?.canCut },
      { label: 'Copy', role: 'copy', enabled: flags?.canCopy },
      { label: 'Paste', role: 'paste', enabled: flags?.canPaste },
      { label: 'Delete', role: 'delete', enabled: flags?.canDelete },
    );
    separator();
    items.push({ label: 'Select All', role: 'selectAll', enabled: flags?.canSelectAll });
  } else if (params?.selectionText) {
    items.push({ label: 'Copy', role: 'copy' });
  }

  if (params?.linkURL && safeExternal(params.linkURL)) {
    separator();
    items.push(
      { label: 'Open Link in Browser', click: () => void shell.openExternal(params.linkURL) },
      { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
    );
  }

  if (context.kind === 'editor' && context.image) {
    separator();
    items.push(
      { label: 'Copy Image', click: () => params && sender.copyImageAt(params.x, params.y) },
      actionItem(sender, context, 'Edit Image Details…', 'editor:image-details'),
      actionItem(sender, context, 'Delete Image', 'editor:image-delete'),
    );
  } else if (context.kind === 'document') {
    separator();
    items.push(
      actionItem(sender, context, 'Open', 'document:open'),
      actionItem(sender, context, 'Rename…', 'document:rename'),
      { type: 'separator' },
      actionItem(sender, context, 'Duplicate', 'document:duplicate'),
      actionItem(sender, context, 'Export…', 'document:export'),
      actionItem(sender, context, 'Reveal in Files', 'document:reveal'),
    );
    if (!context.isMain) items.push(
      actionItem(sender, context, 'Set as Main Document', 'document:set-main'),
      { type: 'separator' },
      actionItem(sender, context, 'Move to Trash…', 'document:trash'),
    );
  } else if (context.kind === 'conversation') {
    separator();
    items.push(
      actionItem(sender, context, 'Open', 'conversation:open'),
      actionItem(sender, context, 'Rename…', 'conversation:rename'),
      { type: 'separator' },
      actionItem(sender, context, 'Delete…', 'conversation:delete'),
    );
  } else if (context.kind === 'message') {
    separator();
    if (context.role === 'user' && context.editable) {
      items.push(actionItem(sender, context, 'Edit Message…', 'message:edit'));
    }
    if (context.role === 'assistant' && context.regeneratable) {
      items.push(
        actionItem(sender, context, 'Regenerate Response…', 'message:regenerate'),
      );
    }
    items.push(actionItem(sender, context, 'Copy Message', 'message:copy'));
  }
  if (items.at(-1)?.type === 'separator') items.pop();
  return items;
}

function popup(sender: WebContents, context: ContextDescriptor, params?: ContextMenuParams, point?: { x: number; y: number }): void {
  const win = BrowserWindow.fromWebContents(sender);
  if (!win) return;
  const template = contextMenuTemplate(sender, context, params);
  if (!template.length) return;
  if (process.env.TEXERIS_CONTEXT_MENU_DIAGNOSTIC) {
    console.error(`[context-menu-diagnostic] ${JSON.stringify({ kind: context.kind, labels: template.map((item) => item.label).filter(Boolean) })}`);
  }
  Menu.buildFromTemplate(template).popup({
    window: win,
    frame: params?.frame ?? undefined,
    sourceType: params?.menuSourceType,
    ...point,
  });
}

export function registerContextMenuHandlers(): void {
  ipcMain.handle(ContextMenuChannels.reply, (event, raw: unknown) => {
    const reply = Value.Decode(ContextDescribeReplySchema, raw);
    const stored = pending.get(reply.requestId);
    if (!stored || stored.sender.id !== event.sender.id) return { shown: false };
    clearTimeout(stored.timer);
    pending.delete(reply.requestId);
    popup(event.sender, reply.context, stored.params);
    return { shown: true };
  });
  ipcMain.handle(ContextMenuChannels.show, (event, raw: unknown) => {
    const request = Value.Decode(ContextShowRequestSchema, raw);
    popup(event.sender, request.context, undefined, { x: request.x, y: request.y });
    return { shown: true };
  });
}

export function attachContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => pending.delete(requestId), 2000);
    pending.set(requestId, { sender: win.webContents, params, timer });
    win.webContents.send(ContextMenuChannels.describe, { requestId, x: params.x, y: params.y });
  });
}
