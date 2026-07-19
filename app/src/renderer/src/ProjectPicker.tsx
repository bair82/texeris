import { useCallback, useEffect, useState } from 'react';

/**
 * First-run project flow: shown when no project is open. Open an existing
 * project folder, pick a recent one, or create a new project.
 */
export default function ProjectPicker() {
  const [recents, setRecents] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.texeris.project.recents().then(setRecents);
  }, []);

  const openDialog = useCallback(async () => {
    setError(null);
    try {
      await window.texeris.project.openDialog();
      // project:changed reloads the app on success
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const openPath = useCallback(async (path: string) => {
    setError(null);
    try {
      await window.texeris.project.openPath(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const create = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    setError(null);
    try {
      const parentDir = await window.texeris.project.pickDirectory();
      if (!parentDir) {
        return;
      }
      await window.texeris.project.create(parentDir, trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [name]);

  return (
    <div className="project-picker">
      <h1>Texeris</h1>
      <p className="picker-sub">Open a project to start writing.</p>
      {error && <p className="chat-error">{error}</p>}
      <div className="picker-actions">
        <button className="picker-primary" onClick={() => void openDialog()}>
          Open project folder…
        </button>
        {creating ? (
          <span className="picker-create-form">
            <input
              autoFocus
              placeholder="project name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void create();
                } else if (e.key === 'Escape') {
                  setCreating(false);
                }
              }}
            />
            <button onClick={() => void create()}>Choose location & create</button>
          </span>
        ) : (
          <button onClick={() => setCreating(true)}>New project…</button>
        )}
      </div>
      {recents.length > 0 && (
        <>
          <h2>Recent</h2>
          <ul className="picker-recents">
            {recents.map((path) => (
              <li key={path}>
                <button onClick={() => void openPath(path)}>{path}</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
