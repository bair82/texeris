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
import { SettingsChannels } from '../shared/settings-types';
import { UiChannels } from '../shared/ui-types';
import { ProjectChannels, type ProjectInfo } from '../shared/project-types';
import { HistoryChannels } from '../shared/doc-types';

const api: TexerisApi = {
  async getAppInfo() {
    const payload: unknown = await ipcRenderer.invoke(IpcChannels.getAppInfo);
    // Validate whatever came across the bridge before handing it to the page.
    return Value.Decode(AppInfoSchema, payload);
  },
  chat: {
    getOrCreateConversation: () =>
      ipcRenderer.invoke(ChatChannels.getOrCreateConversation),
    newConversation: () => ipcRenderer.invoke(ChatChannels.newConversation),
    listConversations: () => ipcRenderer.invoke(ChatChannels.listConversations),
    renameConversation: (conversationId, title) =>
      ipcRenderer.invoke(ChatChannels.renameConversation, { conversationId, title }),
    deleteConversation: (conversationId) =>
      ipcRenderer.invoke(ChatChannels.deleteConversation, { conversationId }),
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
    outline: (documentId) => ipcRenderer.invoke(DocChannels.outline, { documentId }),
    getText: (documentId) => ipcRenderer.invoke(DocChannels.getText, { documentId }),
    commit: (request) => ipcRenderer.invoke(DocChannels.commit, request),
    restore: (revision, documentId) =>
      ipcRenderer.invoke(DocChannels.restore, { revision, documentId }),
    create: (name) => ipcRenderer.invoke(DocChannels.create, { name }),
    rename: (documentId, name) => ipcRenderer.invoke(DocChannels.rename, { documentId, name }),
    trash: (documentId) => ipcRenderer.invoke(DocChannels.trash, { documentId }),
    duplicate: (documentId) => ipcRenderer.invoke(DocChannels.duplicate, { documentId }),
    importDialog: () => ipcRenderer.invoke(DocChannels.importDialog),
    setMain: (documentId) => ipcRenderer.invoke(DocChannels.setMain, { documentId }),
    reveal: (documentId) => ipcRenderer.invoke(DocChannels.reveal, { documentId }),
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
  settings: {
    get: () => ipcRenderer.invoke(SettingsChannels.get),
    setApiKey: (provider, key) =>
      ipcRenderer.invoke(SettingsChannels.setApiKey, { provider, key }),
    clearApiKey: (provider) =>
      ipcRenderer.invoke(SettingsChannels.clearApiKey, { provider }),
  },
  ui: {
    get: () => ipcRenderer.invoke(UiChannels.get),
    set: (state) => ipcRenderer.invoke(UiChannels.set, state),
  },
  project: {
    current: () => ipcRenderer.invoke(ProjectChannels.current),
    recents: () => ipcRenderer.invoke(ProjectChannels.recents),
    pickDirectory: () => ipcRenderer.invoke(ProjectChannels.pickDirectory),
    openDialog: () => ipcRenderer.invoke(ProjectChannels.openDialog),
    openPath: (path) => ipcRenderer.invoke(ProjectChannels.openPath, { path }),
    create: (parentDir, name) =>
      ipcRenderer.invoke(ProjectChannels.create, { parentDir, name }),
    onChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        callback(payload as ProjectInfo);
      };
      ipcRenderer.on(ProjectChannels.changed, listener);
      return () => {
        ipcRenderer.removeListener(ProjectChannels.changed, listener);
      };
    },
  },
  history: {
    revisions: (documentId) => ipcRenderer.invoke(HistoryChannels.revisions, { documentId }),
    listCheckpoints: (documentId) =>
      ipcRenderer.invoke(HistoryChannels.checkpointList, { documentId }),
    createCheckpoint: (name, documentId) =>
      ipcRenderer.invoke(HistoryChannels.checkpointCreate, { documentId, name }),
    restoreCheckpoint: (checkpointId) =>
      ipcRenderer.invoke(HistoryChannels.checkpointRestore, { checkpointId }),
  },
};

contextBridge.exposeInMainWorld('texeris', api);
