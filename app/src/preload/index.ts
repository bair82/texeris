import { contextBridge, ipcRenderer } from 'electron';
import { Value } from '@sinclair/typebox/value';
import {
  AppInfoSchema,
  IpcChannels,
  type TexerisApi,
} from '../shared/ipc-contract';
import { MenuCommandChannel, MenuCommandSchema } from '../shared/commands';
import {
  ChatChannels,
  type NormalizedAgentEvent,
} from '../shared/chat-types';
import { DocChannels, DocEventSchema } from '../shared/doc-types';
import { PatchChannels, PatchProposedEventSchema } from '../shared/patch-types';
import { AppearanceConfigSchema, SettingsChannels } from '../shared/settings-types';
import { UiChannels } from '../shared/ui-types';
import { ProjectChannels, ProjectInfoSchema } from '../shared/project-types';
import { HistoryChannels } from '../shared/doc-types';
import { CorpusChannels, ProfileChannels } from '../shared/profile-types';
import { JobChannels, JobEventSchema } from '../shared/job-types';
import {
  ContextActionEventSchema,
  ContextDescribeRequestSchema,
  ContextMenuChannels,
} from '../shared/context-menu-types';
import { ReferenceChannels } from '../shared/reference-types';
import { ArchiveChannels } from '../shared/archive-types';
import {
  LifecycleChannels,
  RendererFlushRequestSchema,
} from '../shared/lifecycle-types';
import { SkillChannels } from '../shared/skill-types';

const api: TexerisApi = {
  async getAppInfo() {
    const payload: unknown = await ipcRenderer.invoke(IpcChannels.getAppInfo);
    // Validate whatever came across the bridge before handing it to the page.
    return Value.Decode(AppInfoSchema, payload);
  },
  lifecycle: {
    onFlushRequest: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, raw: unknown) =>
        callback(Value.Decode(RendererFlushRequestSchema, raw));
      ipcRenderer.on(LifecycleChannels.flushRequest, listener);
      return () => ipcRenderer.removeListener(LifecycleChannels.flushRequest, listener);
    },
    flushResult: (requestId, error) =>
      ipcRenderer.invoke(LifecycleChannels.flushResult, { requestId, error }),
  },
  onMenuCommand: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, id: unknown) => {
      callback(Value.Decode(MenuCommandSchema, id));
    };
    ipcRenderer.on(MenuCommandChannel, listener);
    return () => {
      ipcRenderer.removeListener(MenuCommandChannel, listener);
    };
  },
  contextMenu: {
    onDescribe: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) =>
        callback(Value.Decode(ContextDescribeRequestSchema, payload));
      ipcRenderer.on(ContextMenuChannels.describe, listener);
      return () => ipcRenderer.removeListener(ContextMenuChannels.describe, listener);
    },
    reply: (requestId, context) => ipcRenderer.invoke(ContextMenuChannels.reply, { requestId, context }),
    show: (context, x, y) => ipcRenderer.invoke(ContextMenuChannels.show, { context, x, y }),
    onAction: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) =>
        callback(Value.Decode(ContextActionEventSchema, payload));
      ipcRenderer.on(ContextMenuChannels.action, listener);
      return () => ipcRenderer.removeListener(ContextMenuChannels.action, listener);
    },
  },
  references: {
    list: () => ipcRenderer.invoke(ReferenceChannels.list),
    search: (query, limit) =>
      ipcRenderer.invoke(ReferenceChannels.search, { query, limit }),
    importDialog: () => ipcRenderer.invoke(ReferenceChannels.importDialog),
    lookupDoi: (doi) =>
      ipcRenderer.invoke(ReferenceChannels.lookupDoi, { doi }),
    create: (draft) =>
      ipcRenderer.invoke(ReferenceChannels.create, draft),
    audit: (markdown) =>
      ipcRenderer.invoke(ReferenceChannels.audit, { markdown }),
  },
  archive: {
    list: () => ipcRenderer.invoke(ArchiveChannels.list),
    importDialog: (source) => ipcRenderer.invoke(ArchiveChannels.importDialog, { source }),
    search: (query, limit) => ipcRenderer.invoke(ArchiveChannels.search, { query, limit }),
    preview: (sourceId, offset) =>
      ipcRenderer.invoke(ArchiveChannels.preview, { sourceId, offset }),
    delete: (sourceId) => ipcRenderer.invoke(ArchiveChannels.delete, { sourceId }),
    reindex: () => ipcRenderer.invoke(ArchiveChannels.reindex),
    passages: (passageIds) =>
      ipcRenderer.invoke(ArchiveChannels.passages, { passageIds }),
    buildProfile: (sourceIds) =>
      ipcRenderer.invoke(ArchiveChannels.buildProfile, { sourceIds }),
  },
  skills: {
    list: () => ipcRenderer.invoke(SkillChannels.list),
    launch: (request) => ipcRenderer.invoke(SkillChannels.launch, request),
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
    listDelegations: (conversationId) =>
      ipcRenderer.invoke(ChatChannels.listDelegations, { conversationId }),
    previewMessageEdit: (conversationId, messageSeq) =>
      ipcRenderer.invoke(ChatChannels.previewMessageEdit, { conversationId, messageSeq }),
    forkMessage: (conversationId, messageSeq, reason) =>
      ipcRenderer.invoke(ChatChannels.forkMessage, {
        conversationId,
        messageSeq,
        reason,
      }),
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
  profile: {
    begin: (request) => ipcRenderer.invoke(ProfileChannels.begin, request),
  },
  jobs: {
    cancel: (jobId) => ipcRenderer.invoke(JobChannels.cancel, { jobId }),
    onEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        callback(Value.Decode(JobEventSchema, payload));
      };
      ipcRenderer.on(JobChannels.event, listener);
      return () => {
        ipcRenderer.removeListener(JobChannels.event, listener);
      };
    },
  },
  corpus: {
    list: () => ipcRenderer.invoke(CorpusChannels.list),
    deleteGrant: (grantId) => ipcRenderer.invoke(CorpusChannels.delete, { grantId }),
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
    addImage: (request) => ipcRenderer.invoke(DocChannels.addImage, request),
    importDialog: () => ipcRenderer.invoke(DocChannels.importDialog),
    exportSettings: () => ipcRenderer.invoke(DocChannels.exportSettings),
    chooseCitationStyle: () => ipcRenderer.invoke(DocChannels.chooseCitationStyle),
    exportDialog: (documentId, citationStyle) =>
      ipcRenderer.invoke(DocChannels.exportDialog, { documentId, citationStyle }),
    setMain: (documentId) => ipcRenderer.invoke(DocChannels.setMain, { documentId }),
    reveal: (documentId) => ipcRenderer.invoke(DocChannels.reveal, { documentId }),
    trashList: () => ipcRenderer.invoke(DocChannels.trashList),
    restoreTrash: (documentId) =>
      ipcRenderer.invoke(DocChannels.restoreTrash, { documentId }),
    deleteTrash: (documentId) =>
      ipcRenderer.invoke(DocChannels.deleteTrash, { documentId }),
    onEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        callback(Value.Decode(DocEventSchema, payload));
      };
      ipcRenderer.on(DocChannels.event, listener);
      return () => {
        ipcRenderer.removeListener(DocChannels.event, listener);
      };
    },
  },
  patch: {
    list: (documentId) => ipcRenderer.invoke(PatchChannels.list, { documentId }),
    get: (patchId) => ipcRenderer.invoke(PatchChannels.get, { patchId }),
    accept: (patchId, groupIds) =>
      ipcRenderer.invoke(PatchChannels.accept, { patchId, groupIds }),
    reject: (patchId, groupIds) =>
      ipcRenderer.invoke(PatchChannels.reject, { patchId, groupIds }),
    onEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        callback(Value.Decode(PatchProposedEventSchema, payload));
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
    setSpellcheck: (input) =>
      ipcRenderer.invoke(SettingsChannels.setSpellcheck, input),
    setAppearance: (input) =>
      ipcRenderer.invoke(SettingsChannels.setAppearance, input),
    setPatchStyleMode: (mode) =>
      ipcRenderer.invoke(SettingsChannels.setPatchStyleMode, { mode }),
    disableWritingProfile: () =>
      ipcRenderer.invoke(SettingsChannels.disableWritingProfile),
    onAppearanceChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        callback(Value.Decode(AppearanceConfigSchema, payload));
      };
      ipcRenderer.on(SettingsChannels.appearanceChanged, listener);
      return () => {
        ipcRenderer.removeListener(SettingsChannels.appearanceChanged, listener);
      };
    },
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
        callback(Value.Decode(ProjectInfoSchema, payload));
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
    createCheckpoint: (name, documentId, description) =>
      ipcRenderer.invoke(HistoryChannels.checkpointCreate, { documentId, name, description }),
    restoreCheckpoint: (checkpointId) =>
      ipcRenderer.invoke(HistoryChannels.checkpointRestore, { checkpointId }),
  },
};

contextBridge.exposeInMainWorld('texeris', api);
