import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { DocumentInfo } from '../../../shared/domain-types';
import type { JobEvent } from '../../../shared/job-types';
import type { CitationStyleId } from '../../../shared/citation-style-types';
import type { ArchiveAttachment } from '../../../shared/archive-types';
import type { HeadingInfo } from '../../../shared/doc-types';
import type { SkillSummary } from '../../../shared/skill-types';
import type { UiState, UiStateDoc } from '../../../shared/ui-types';
import ChatPanel from '../ChatPanel';
import PatchReview from '../PatchReview';
import EditorRegion, { type WorkspaceStatus } from '../editor/EditorRegion';
import {
  getChatCommands,
  getEditorCommands,
  getEditorSelection,
  navigateToHeading,
} from '../editor/editorBridge';
import type { EditorMode } from '../editor/session';
import ActivityBar from './ActivityBar';
import CommandPalette from './CommandPalette';
import ProjectNav from './ProjectNav';
import ShortcutsOverlay from './ShortcutsOverlay';
import TrashDialog from './TrashDialog';
import ExportDialog from './ExportDialog';
import ArchivePanel from './ArchivePanel';
import SkillLaunchDialog from './SkillLaunchDialog';
import { describeContextAt, dispatchContextAction } from '../contextMenuBridge';

const DEFAULT_NAV_WIDTH = 232;
const DEFAULT_SIDE_WIDTH = 400;
const NAV_MIN = 160;
const NAV_MAX = 420;
const SIDE_MIN = 300;
const SIDE_MAX = 660;
const SAVE_DEBOUNCE_MS = 400;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Cancelled job invokes reject with a 'cancelled' error (Electron prefixes it). */
const isJobCancellation = (error: unknown): boolean =>
  /\bcancelled\b/.test(error instanceof Error ? error.message : String(error));

/**
 * Set before a project-switch reload (App.tsx): the beforeunload flush must
 * NOT fire for that reload, or the outgoing project's ui state would be
 * written into the incoming project's database.
 */
export const PROJECT_SWITCH_FLAG = 'texeris:project-switch';

/**
 * The workspace shell (M1.5 EU1, plan §12): activity rail plus three
 * regions — project navigation, editor, assistant column. Both side regions
 * are collapsible and drag-resizable; focus mode hides them both. All of it
 * persists per project through the ui:get/ui:set IPC channel, so a relaunch
 * restores the desk exactly as it was left.
 */
export default function AppShell({
  onOpenSettings,
  onOpenProjectPicker,
  mainDocument,
}: {
  onOpenSettings: () => void;
  /** Return to the project picker to open or create a project. */
  onOpenProjectPicker: () => Promise<void>;
  mainDocument: string;
}) {
  const [ui, setUi] = useState<UiState | null>(null);
  const [docs, setDocs] = useState<DocumentInfo[]>([]);
  const [openDocId, setOpenDocId] = useState<string | null>(null);
  const [openDocRevision, setOpenDocRevision] = useState(0);
  const [mainPath, setMainPath] = useState(mainDocument);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [newDocRequested, setNewDocRequested] = useState(0);
  const [profileSourceOpen, setProfileSourceOpen] = useState(false);
  const [skillLaunch, setSkillLaunch] = useState<{
    skill: SkillSummary;
    documentId: string;
    selection: { from: number; to: number } | null;
    headings: HeadingInfo[];
  } | null>(null);
  const [exportTargetId, setExportTargetId] = useState<string | null>(null);
  const [archiveAttachments, setArchiveAttachments] = useState<ArchiveAttachment[]>([]);
  const [operationNotice, setOperationNotice] = useState<WorkspaceStatus | null>(null);
  const uiRef = useRef<UiState>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exportingRef = useRef(false);
  /** The import/export/corpus job currently backing the progress notice. */
  const activeJobRef = useRef<{ op: JobEvent['op']; jobId: string | null } | null>(null);

  // Boot: load layout state + document list, then pick the document to open
  // (the one from last session when it still exists, else the first).
  useEffect(() => {
    // The switch flag did its job (the stale blob was not flushed) — clear it
    // so ordinary unloads persist again.
    sessionStorage.removeItem(PROJECT_SWITCH_FLAG);
    void (async () => {
      const [state, list] = await Promise.all([
        window.texeris.ui.get(),
        window.texeris.doc.list(),
      ]);
      uiRef.current = state;
      setUi(state);
      setDocs(list);
      const saved = state.openDocumentId;
      setOpenDocId(
        saved && list.some((d) => d.id === saved) ? saved : (list[0]?.id ?? null),
      );
    })();
  }, []);

  // Keep the file list in sync with external changes.
  useEffect(() => {
    return window.texeris.doc.onEvent(() => {
      void window.texeris.doc.list().then(setDocs);
    });
  }, []);

  // Completed operations should be visible but not permanent. Warnings stay
  // longer; errors remain until the user dismisses them.
  useEffect(() => {
    if (!operationNotice || operationNotice.tone === 'progress' || operationNotice.tone === 'error') {
      return;
    }
    const timer = window.setTimeout(
      () => setOperationNotice(null),
      operationNotice.tone === 'warning' ? 12_000 : 6_000,
    );
    return () => window.clearTimeout(timer);
  }, [operationNotice]);

  const cancelActiveJob = useCallback(() => {
    const jobId = activeJobRef.current?.jobId;
    if (jobId) void window.texeris.jobs.cancel(jobId);
  }, []);

  const jobProgressNotice = useCallback(
    (op: JobEvent['op'], progress?: { done: number; total: number }): WorkspaceStatus => {
      const base = op === 'import'
        ? 'Importing document…'
        : op === 'export'
          ? 'Exporting document…'
          : 'Analyzing writing corpus…';
      return {
        message: progress ? `${base} (${progress.done}/${progress.total} files)` : base,
        tone: 'progress',
        onCancel: cancelActiveJob,
      };
    },
    [cancelActiveJob],
  );

  // While a job invoke is in flight, mirror its progress into the notice and
  // remember the jobId so the Cancel button can abort it.
  useEffect(() => {
    return window.texeris.jobs.onEvent((event) => {
      const active = activeJobRef.current;
      if (!active || event.op !== active.op) return;
      if (event.status === 'started') active.jobId = event.jobId;
      if (event.status === 'progress') {
        setOperationNotice(jobProgressNotice(active.op, event.progress));
      }
    });
  }, [jobProgressNotice]);

  const persist = useCallback((immediate: boolean) => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (immediate) {
      void window.texeris.ui.set(uiRef.current);
    } else {
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        void window.texeris.ui.set(uiRef.current);
      }, SAVE_DEBOUNCE_MS);
    }
  }, []);

  const patchUi = useCallback(
    (patch: Partial<UiState>, immediate = false) => {
      const next = { ...uiRef.current, ...patch };
      uiRef.current = next;
      setUi(next);
      persist(immediate);
    },
    [persist],
  );

  // Flush a pending debounced save before the window reloads — but not when
  // the reload is a project switch: uiRef still holds the OUTGOING project's
  // state, and persisting it would clobber the incoming project's database.
  useEffect(() => {
    const flush = () => {
      if (sessionStorage.getItem(PROJECT_SWITCH_FLAG)) {
        return;
      }
      persist(true);
    };
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, [persist]);

  const focusMode = ui?.focusMode ?? false;
  const navVisible = !focusMode && (ui?.navVisible ?? true);
  const navMode = ui?.navMode ?? 'files';
  const sideVisible = !focusMode && (ui?.sideVisible ?? true);
  const navWidth = ui?.navWidth ?? DEFAULT_NAV_WIDTH;
  const sideWidth = ui?.sideWidth ?? DEFAULT_SIDE_WIDTH;

  const toggleNav = useCallback(() => {
    const focus = uiRef.current.focusMode ?? false;
    const nav = !focus && (uiRef.current.navVisible ?? true);
    patchUi(focus ? { focusMode: false, navVisible: true } : { navVisible: !nav }, true);
  }, [patchUi]);
  const toggleNavMode = useCallback((mode: 'files' | 'archive') => {
    const focus = uiRef.current.focusMode ?? false;
    const visible = !focus && (uiRef.current.navVisible ?? true);
    const currentMode = uiRef.current.navMode ?? 'files';
    if (visible && currentMode === mode) {
      patchUi({ navVisible: false }, true);
    } else {
      patchUi({ focusMode: false, navVisible: true, navMode: mode }, true);
    }
  }, [patchUi]);
  const toggleSide = useCallback(() => {
    const focus = uiRef.current.focusMode ?? false;
    const side = !focus && (uiRef.current.sideVisible ?? true);
    patchUi(focus ? { focusMode: false, sideVisible: true } : { sideVisible: !side }, true);
  }, [patchUi]);
  const toggleFocus = useCallback(
    () => patchUi({ focusMode: !(uiRef.current.focusMode ?? false) }, true),
    [patchUi],
  );
  const openProjectPickerSafely = useCallback(async () => {
    try {
      await onOpenProjectPicker();
    } catch (error) {
      setOperationNotice({
        message: `Could not save before switching projects: ${
          error instanceof Error ? error.message : String(error)
        }`,
        tone: 'error',
      });
    }
  }, [onOpenProjectPicker]);

  const openDoc = useCallback(
    (documentId: string) => {
      if (documentId === openDocId) {
        return;
      }
      setOpenDocId(documentId);
      patchUi({ openDocumentId: documentId }, true);
    },
    [openDocId, patchUi],
  );

  const refreshDocs = useCallback(async () => {
    setDocs(await window.texeris.doc.list());
  }, []);

  const createDoc = async (name: string) => {
    const created = await window.texeris.doc.create(
      name.endsWith('.md') ? name : `${name}.md`,
    );
    setDocs(await window.texeris.doc.list());
    openDoc(created.id);
  };

  // -------------------------------------------------- document management

  const onRenameDoc = useCallback(
    async (documentId: string, name: string) => {
      const oldPath = docs.find((d) => d.id === documentId)?.path;
      const renamed = await window.texeris.doc.rename(documentId, name);
      await refreshDocs();
      if (oldPath === mainPath) {
        setMainPath(renamed.path);
      }
    },
    [docs, refreshDocs, mainPath],
  );

  const onTrashDoc = useCallback(
    async (documentId: string) => {
      await window.texeris.doc.trash(documentId);
      const list = await window.texeris.doc.list();
      setDocs(list);
      if (openDocId === documentId) {
        const next = list[0]?.id ?? null;
        setOpenDocId(next);
        patchUi({ openDocumentId: next }, true);
      }
    },
    [openDocId, patchUi],
  );

  const onDuplicateDoc = useCallback(
    async (documentId: string) => {
      const dup = await window.texeris.doc.duplicate(documentId);
      setDocs(await window.texeris.doc.list());
      openDoc(dup.id);
    },
    [openDoc],
  );

  const onImportDoc = useCallback(async () => {
    activeJobRef.current = { op: 'import', jobId: null };
    try {
      setOperationNotice(jobProgressNotice('import'));
      const imported = await window.texeris.doc.importDialog();
      if (imported) {
        setDocs(await window.texeris.doc.list());
        openDoc(imported.id);
        setOperationNotice({
          message: imported.warnings.length
            ? `Imported ${imported.path}. ${imported.warnings.join(' ')}`
            : `Imported ${imported.path}.`,
          tone: imported.warnings.length ? 'warning' : 'success',
        });
      } else {
        setOperationNotice(null);
      }
    } catch (error) {
      setOperationNotice({
        message: isJobCancellation(error)
          ? 'Import cancelled.'
          : `Import failed: ${error instanceof Error ? error.message : String(error)}`,
        tone: isJobCancellation(error) ? 'warning' : 'error',
      });
    } finally {
      activeJobRef.current = null;
    }
  }, [openDoc, jobProgressNotice]);

  const onExportDoc = useCallback(async (documentId?: string) => {
    const targetId = documentId ?? openDocId;
    if (!targetId || exportingRef.current) return;
    if (targetId === openDocId) await getEditorCommands()?.flush();
    setExportTargetId(targetId);
  }, [openDocId]);

  const performExport = useCallback(async (
    targetId: string,
    citationStyle: CitationStyleId,
  ) => {
    if (exportingRef.current) return;
    exportingRef.current = true;
    activeJobRef.current = { op: 'export', jobId: null };
    try {
      setOperationNotice(jobProgressNotice('export'));
      const exported = await window.texeris.doc.exportDialog(targetId, citationStyle);
      if (exported) {
        setOperationNotice({
          message: exported.warnings.length
            ? `Exported to ${exported.path}. ${exported.warnings.join(' ')}`
            : `Exported to ${exported.path}.`,
          tone: exported.warnings.length ? 'warning' : 'success',
        });
      } else {
        setOperationNotice(null);
      }
    } catch (error) {
      setOperationNotice({
        message: isJobCancellation(error)
          ? 'Export cancelled.'
          : `Export failed: ${error instanceof Error ? error.message : String(error)}`,
        tone: isJobCancellation(error) ? 'warning' : 'error',
      });
    } finally {
      exportingRef.current = false;
      activeJobRef.current = null;
      setExportTargetId(null);
    }
  }, [jobProgressNotice]);

  const onSetMainDoc = useCallback(async (documentId: string) => {
    const info = await window.texeris.doc.setMain(documentId);
    setMainPath(info.mainDocument);
  }, []);

  const onRevealDoc = useCallback(async (documentId: string) => {
    await window.texeris.doc.reveal(documentId);
  }, []);

  // A restored document rejoins the nav and opens right away (EU7).
  const onRestoredDoc = useCallback(
    async (doc: { id: string }) => {
      setDocs(await window.texeris.doc.list());
      openDoc(doc.id);
    },
    [openDoc],
  );

  // ------------------------------------------------------- command registry

  const openConservativeRewrite = useCallback(async () => {
    if (!openDocId) {
      setOperationNotice({ message: 'Open a document before starting a rewrite.', tone: 'warning' });
      return;
    }
    try {
      const [skills, headings] = await Promise.all([
        window.texeris.skills.list(),
        window.texeris.doc.outline(openDocId),
      ]);
      const skill = skills.find((item) => item.id === 'conservative-rewrite');
      if (!skill) throw new Error('Conservative rewrite is unavailable');
      setSkillLaunch({
        skill,
        documentId: openDocId,
        selection: getEditorSelection(),
        headings,
      });
    } catch (error) {
      setOperationNotice({
        message: `Could not open Conservative rewrite: ${
          error instanceof Error ? error.message : String(error)
        }`,
        tone: 'error',
      });
    }
  }, [openDocId]);

  /** Every app-menu / palette command (M1.5 EU5) routes through here. */
  const runCommand = useCallback(
    (id: string) => {
      const editor = getEditorCommands();
      switch (id) {
        case 'file:new-document': {
          // the new-doc form lives in the nav — make sure it is visible
          const focus = uiRef.current.focusMode ?? false;
          const nav = !focus && (uiRef.current.navVisible ?? true);
          if (!nav) {
            patchUi({ focusMode: false, navVisible: true, navMode: 'files' }, true);
          } else if ((uiRef.current.navMode ?? 'files') !== 'files') {
            patchUi({ navMode: 'files' }, true);
          }
          setNewDocRequested((n) => n + 1);
          break;
        }
        case 'file:new-project':
          void openProjectPickerSafely();
          break;
        case 'file:import-document':
          void onImportDoc();
          break;
        case 'file:export-document':
          void onExportDoc();
          break;
        case 'file:switch-project':
          void openProjectPickerSafely();
          break;
        case 'edit:undo':
          editor?.undo();
          break;
        case 'edit:redo':
          editor?.redo();
          break;
        case 'edit:find':
          editor?.openSearch();
          break;
        case 'edit:insert-citation':
          editor?.openCitationPicker();
          break;
        case 'view:command-palette':
          setPaletteOpen((v) => !v);
          break;
        case 'view:toggle-mode':
          editor?.toggleMode();
          break;
        case 'view:toggle-nav':
          toggleNav();
          break;
        case 'view:toggle-side':
          toggleSide();
          break;
        case 'view:toggle-focus':
          toggleFocus();
          break;
        case 'view:toggle-history':
          editor?.toggleHistory();
          break;
        case 'chat:new':
          getChatCommands()?.newConversation();
          break;
        case 'chat:build-writing-profile':
          setProfileSourceOpen(true);
          break;
        case 'chat:conservative-rewrite':
          void openConservativeRewrite();
          break;
        case 'help:shortcuts':
          setShortcutsOpen((v) => !v);
          break;
      }
    },
    [
      onExportDoc,
      onImportDoc,
      openConservativeRewrite,
      openProjectPickerSafely,
      patchUi,
      toggleNav,
      toggleSide,
      toggleFocus,
    ],
  );

  // App-menu commands from main.
  useEffect(() => window.texeris.onMenuCommand(runCommand), [runCommand]);

  useEffect(() => {
    const offDescribe = window.texeris.contextMenu.onDescribe((request) => {
      void window.texeris.contextMenu.reply(
        request.requestId,
        describeContextAt(request.x, request.y),
      );
    });
    const offAction = window.texeris.contextMenu.onAction((event) => {
      if (event.context.kind === 'editor' && getEditorCommands()?.contextAction(event.action)) return;
      dispatchContextAction(event);
    });
    return () => { offDescribe(); offAction(); };
  }, []);

  // Ctrl+K / Ctrl+P fallback for environments where menu accelerators don't
  // fire (menu accelerators win when both work — the key never reaches us).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'k' || e.key === 'p')) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onDocState = useCallback(
    (docId: string, patch: UiStateDoc) => {
      const documents = { ...uiRef.current.documents };
      documents[docId] = { ...documents[docId], ...patch };
      patchUi({ documents });
    },
    [patchUi],
  );

  const onModeChange = useCallback(
    (mode: EditorMode) => patchUi({ editorMode: mode }, true),
    [patchUi],
  );

  const onRevisionChange = useCallback((revision: number) => {
    setOpenDocRevision(revision);
  }, []);

  const startDrag =
    (which: 'nav' | 'side') =>
    (e: ReactMouseEvent): void => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = which === 'nav' ? navWidth : sideWidth;
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        if (which === 'nav') {
          patchUi({ navWidth: clamp(startWidth + dx, NAV_MIN, NAV_MAX) });
        } else {
          patchUi({ sideWidth: clamp(startWidth - dx, SIDE_MIN, SIDE_MAX) });
        }
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.classList.remove('col-resizing');
      };
      document.body.classList.add('col-resizing');
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    };

  if (!ui) {
    // Layout state not loaded yet — render nothing rather than a frame that
    // would visibly snap into place a moment later.
    return <div className="app-columns" />;
  }

  return (
    <div className="app-columns">
      <ActivityBar
        filesActive={navVisible && navMode === 'files'}
        archiveActive={navVisible && navMode === 'archive'}
        sideActive={sideVisible}
        focusMode={focusMode}
        onToggleFiles={() => toggleNavMode('files')}
        onToggleArchive={() => toggleNavMode('archive')}
        onToggleSide={toggleSide}
        onToggleFocus={toggleFocus}
        onOpenSettings={onOpenSettings}
      />
      {navVisible && (
        <>
          {navMode === 'files' ? <ProjectNav
            width={navWidth}
            docs={docs}
            openDocId={openDocId}
            mainPath={mainPath}
            openDocRevision={openDocRevision}
            newDocRequested={newDocRequested}
            onOpenDoc={openDoc}
            onCreateDoc={createDoc}
            onRenameDoc={onRenameDoc}
            onTrashDoc={onTrashDoc}
            onDuplicateDoc={onDuplicateDoc}
            onExportDoc={onExportDoc}
            onImportDoc={onImportDoc}
            onSetMainDoc={onSetMainDoc}
            onRevealDoc={onRevealDoc}
            onOpenTrash={() => setTrashOpen(true)}
            onNavigate={navigateToHeading}
          /> : <ArchivePanel
            width={navWidth}
            attachedPassageIds={new Set(archiveAttachments.map((item) => item.passageId))}
            onAttach={(result) =>
              setArchiveAttachments((current) =>
                current.some((item) => item.passageId === result.passageId)
                  ? current
                  : [...current, result].slice(0, 12),
              )
            }
            onProfileStarted={openProfileResult}
          />}
          <div
            className="split-handle"
            role="separator"
            aria-orientation="vertical"
            onMouseDown={startDrag('nav')}
          />
        </>
      )}
      <EditorRegion
        openDocId={openDocId}
        docStates={ui.documents ?? {}}
        initialMode={ui.editorMode ?? 'rendered'}
        onDocState={onDocState}
        onModeChange={onModeChange}
        onRevisionChange={onRevisionChange}
        workspaceStatus={operationNotice}
        onDismissWorkspaceStatus={() => setOperationNotice(null)}
      />
      {sideVisible && (
        <>
          <div
            className="split-handle"
            role="separator"
            aria-orientation="vertical"
            onMouseDown={startDrag('side')}
          />
          <div className="side-column" style={{ width: sideWidth }}>
            <PatchReview documentId={openDocId} />
            <ChatPanel
              documentId={openDocId}
              onOpenDocument={(id) => {
                void refreshDocs().then(() => openDoc(id));
              }}
              initialConversationId={ui.openConversationId ?? null}
              onConversationChange={(id) => patchUi({ openConversationId: id })}
              archiveAttachments={archiveAttachments}
              onRemoveArchiveAttachment={(passageId) =>
                setArchiveAttachments((current) =>
                  current.filter((item) => item.passageId !== passageId),
                )
              }
              onArchiveAttachmentsUsed={() => setArchiveAttachments([])}
            />
          </div>
        </>
      )}
      {paletteOpen && (
        <CommandPalette onRun={runCommand} onClose={() => setPaletteOpen(false)} />
      )}
      {shortcutsOpen && <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}
      {trashOpen && (
        <TrashDialog onClose={() => setTrashOpen(false)} onRestored={onRestoredDoc} />
      )}
      {exportTargetId && (
        <ExportDialog
          documentTitle={docs.find((doc) => doc.id === exportTargetId)?.title ?? 'document'}
          onExport={(style) => performExport(exportTargetId, style)}
          onClose={() => setExportTargetId(null)}
        />
      )}
      {profileSourceOpen && (
        <div className="settings-overlay" onClick={() => setProfileSourceOpen(false)}>
          <div className="profile-source-dialog" onClick={(event) => event.stopPropagation()}>
            <h2>Build writing profile</h2>
            <p>Choose individual writing files or recursively analyze a folder.</p>
            <div className="patch-actions">
              <button onClick={() => void beginProfile('files')}>Choose files…</button>
              <button onClick={() => void beginProfile('folder')}>Choose folder…</button>
              <button onClick={() => setProfileSourceOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {skillLaunch && (
        <SkillLaunchDialog
          {...skillLaunch}
          onClose={() => setSkillLaunch(null)}
          onLaunch={async ({ mode, optionId, scope }) => {
            await getEditorCommands()?.flush();
            const result = await window.texeris.skills.launch({
              skillId: skillLaunch.skill.id,
              mode,
              optionId,
              scope,
            });
            setSkillLaunch(null);
            patchUi(
              {
                focusMode: false,
                sideVisible: true,
                openConversationId: result.conversationId,
              },
              true,
            );
            getChatCommands()?.openConversation(result.conversationId);
          }}
        />
      )}
    </div>
  );

  async function beginProfile(source: 'files' | 'folder'): Promise<void> {
    activeJobRef.current = { op: 'corpus-grant', jobId: null };
    try {
      setOperationNotice(jobProgressNotice('corpus-grant'));
      const result = await window.texeris.profile.begin({ source });
      if (!result) {
        setOperationNotice(null);
        return;
      }
      openProfileResult(result);
    } catch (error) {
      if (isJobCancellation(error)) {
        setOperationNotice({ message: 'Corpus grant cancelled.', tone: 'warning' });
      } else {
        setOperationNotice(null);
        window.alert(error instanceof Error ? error.message : String(error));
      }
    } finally {
      activeJobRef.current = null;
    }
  }

  function openProfileResult(result: {
    conversationId: string;
    warnings: string[];
  }): void {
    setProfileSourceOpen(false);
    patchUi(
      {
        focusMode: false,
        sideVisible: true,
        openConversationId: result.conversationId,
      },
      true,
    );
    getChatCommands()?.openConversation(result.conversationId);
    setOperationNotice(
      result.warnings.length
        ? {
            message: `Corpus grant created with warnings. ${result.warnings.join(' ')}`,
            tone: 'warning',
          }
        : null,
    );
  }
}
