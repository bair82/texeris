import { useEffect, useState } from 'react';
import type { AppInfo } from '../../shared/ipc-contract';
import type { ProjectInfo } from '../../shared/project-types';
import ChatPanel from './ChatPanel';
import EditorRegion from './editor/EditorRegion';
import PatchReview from './PatchReview';
import ProjectPicker from './ProjectPicker';
import SettingsPanel from './SettingsPanel';

export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [project, setProject] = useState<ProjectInfo | null | undefined>(undefined);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    window.texeris.getAppInfo().then(setInfo).catch(console.error);
    window.texeris.project.current().then(setProject).catch(console.error);
    // Full reload on project switch — every pane re-reads its data.
    return window.texeris.project.onChanged(() => {
      window.location.reload();
    });
  }, []);

  if (project === undefined) {
    return null; // loading
  }
  if (project === null) {
    return <ProjectPicker />;
  }

  return (
    <main className="app-shell">
      <div className="app-columns">
        <EditorRegion />
        <div className="side-column">
          <PatchReview />
          <ChatPanel />
        </div>
      </div>
      <footer className="app-footer">
        <span className="project-chip" title={project.root}>
          {project.root.split('/').pop()}
        </span>
        <button
          className="settings-button"
          title="Switch project"
          onClick={() => {
            void (async () => {
              try {
                await window.texeris.project.openDialog();
              } catch {
                /* user cancelled or open failed — stay */
              }
            })();
          }}
        >
          switch
        </button>
        {info && `Texeris · Electron ${info.electronVersion} · Node ${info.nodeVersion}`}
        <button className="settings-button" onClick={() => setShowSettings(true)}>
          ⚙ Settings
        </button>
      </footer>
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </main>
  );
}
