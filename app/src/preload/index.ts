import { contextBridge, ipcRenderer } from 'electron';
import { Value } from '@sinclair/typebox/value';
import {
  AppInfoSchema,
  IpcChannels,
  type TexerisApi,
} from '../shared/ipc-contract';
import {
  ChatChannels,
  type NormalizedAgentEvent,
} from '../shared/chat-types';
import { DocChannels, type DocEvent } from '../shared/doc-types';
import { PatchChannels, type PatchProposedEvent } from '../shared/patch-types';

const api: TexerisApi = {
  async getAppInfo() {
    const payload: unknown = await ipcRenderer.invoke(IpcChannels.getAppInfo);
    // Validate whatever came across the bridge before handing it to the page.
    return Value.Decode(AppInfoSchema, payload);
  },
  chat: {
    getOrCreateConversation: () =>
      ipcRenderer.invoke(ChatChannels.getOrCreateConversation),
    listMessages: (conversationId) =>
      ipcRenderer.invoke(ChatChannels.listMessages, { conversationId }),
    listRuns: (conversationId) =>
      ipcRenderer.invoke(ChatChannels.listRuns, { conversationId }),
    startTurn: (request) => ipcRenderer.invoke(ChatChannels.startTurn, request),
    cancel: (runId) => ipcRenderer.invoke(ChatChannels.cancel, { runId }),
    onEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        callback(payload as NormalizedAgentEvent);
      };
      ipcRenderer.on(ChatChannels.event, listener);
      return () => {
        ipcRenderer.removeListener(ChatChannels.event, listener);
      };
    },
  },
  doc: {
    list: () => ipcRenderer.invoke(DocChannels.list),
    outline: () => ipcRenderer.invoke(DocChannels.outline),
    getText: () => ipcRenderer.invoke(DocChannels.getText),
    commit: (request) => ipcRenderer.invoke(DocChannels.commit, request),
    restore: (revision) => ipcRenderer.invoke(DocChannels.restore, { revision }),
    onEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        callback(payload as DocEvent);
      };
      ipcRenderer.on(DocChannels.event, listener);
      return () => {
        ipcRenderer.removeListener(DocChannels.event, listener);
      };
    },
  },
  patch: {
    list: () => ipcRenderer.invoke(PatchChannels.list),
    get: (patchId) => ipcRenderer.invoke(PatchChannels.get, { patchId }),
    accept: (patchId, groupIds) =>
      ipcRenderer.invoke(PatchChannels.accept, { patchId, groupIds }),
    reject: (patchId, groupIds) =>
      ipcRenderer.invoke(PatchChannels.reject, { patchId, groupIds }),
    onEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        callback(payload as PatchProposedEvent);
      };
      ipcRenderer.on(PatchChannels.event, listener);
      return () => {
        ipcRenderer.removeListener(PatchChannels.event, listener);
      };
    },
  },
};

contextBridge.exposeInMainWorld('texeris', api);
