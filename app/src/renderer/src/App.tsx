import { useEffect, useState } from 'react';
import type { AppInfo } from '../../shared/ipc-contract';
import ChatPanel from './ChatPanel';
import EditorRegion from './editor/EditorRegion';
import PatchReview from './PatchReview';
import SettingsPanel from './SettingsPanel';

export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    window.texeris.getAppInfo().then(setInfo).catch(console.error);
  }, []);

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
        {info && `Texeris · Electron ${info.electronVersion} · Node ${info.nodeVersion}`}
        <button className="settings-button" onClick={() => setShowSettings(true)}>
          settings
        </button>
      </footer>
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </main>
  );
}
