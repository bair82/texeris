import { useEffect, useState } from 'react';
import type { AppInfo } from '../../shared/ipc-contract';
import ChatPanel from './ChatPanel';
import EditorRegion from './editor/EditorRegion';
import PatchReview from './PatchReview';

export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);

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
      </footer>
    </main>
  );
}
