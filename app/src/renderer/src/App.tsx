import { useEffect, useState } from 'react';
import type { AppInfo } from '../../shared/ipc-contract';
import type { ProjectInfo } from '../../shared/project-types';
import { initAppearance } from './appearance';
import AppShell, { PROJECT_SWITCH_FLAG } from './layout/AppShell';
import ProjectPicker from './ProjectPicker';
import SettingsPanel from './SettingsPanel';

export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [project, setProject] = useState<ProjectInfo | null | undefined>(undefined);
  const [showSettings, setShowSettings] = useState(false);
  const [showProjectPicker, setShowProjectPicker] = useState(false);

  useEffect(() => {
    void initAppearance().catch(console.error);
    window.texeris.getAppInfo().then(setInfo).catch(console.error);
    window.texeris.project.current().then(setProject).catch(console.error);
    // Full reload on project switch — every pane re-reads its data. Flag it
    // so AppShell's beforeunload flush does not write this project's ui
    // state into the incoming project's database.
    return window.texeris.project.onChanged(() => {
      sessionStorage.setItem(PROJECT_SWITCH_FLAG, '1');
      window.location.reload();
    });
  }, []);

  if (project === undefined) {
    return null; // loading
  }
  if (project === null || showProjectPicker) {
    return <ProjectPicker onBack={project ? () => setShowProjectPicker(false) : undefined} />;
  }

  return (
    <main className="app-shell">
      <AppShell
        onOpenSettings={() => setShowSettings(true)}
        onOpenProjectPicker={() => setShowProjectPicker(true)}
        mainDocument={project.mainDocument}
      />
      <footer className="app-footer">
        <span className="project-chip" title={project.root}>
          {project.root.split('/').pop()}
        </span>
        <button
          className="footer-button"
          title="Open or create a project"
          onClick={() => setShowProjectPicker(true)}
        >
          projects…
        </button>
        <span className="footer-version">
          {info && `Texeris · Electron ${info.electronVersion} · Node ${info.nodeVersion}`}
        </span>
      </footer>
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </main>
  );
}
