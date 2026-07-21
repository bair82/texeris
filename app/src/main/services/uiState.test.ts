import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, type ProjectContext } from './project';
import { UiStateService } from './uiState';

let root: string;
let ctx: ProjectContext;
let ui: UiStateService;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-ui-'));
  ctx = createProject(root);
  // createProject seeds ui.state (the welcome document, EU7) — the service
  // tests below start from a clean slate instead.
  ctx.db.prepare("DELETE FROM settings WHERE key = 'ui.state'").run();
  ui = new UiStateService(ctx.db);
});

afterEach(() => {
  ctx.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('UiStateService', () => {
  it('returns empty state when nothing is stored', () => {
    expect(ui.get()).toEqual({});
  });

  it('round-trips a full state blob', () => {
    const state = {
      navWidth: 240,
      sideWidth: 420,
      navVisible: false,
      sideVisible: true,
      focusMode: false,
      editorMode: 'raw' as const,
      openDocumentId: 'doc-1',
      documents: { 'doc-1': { cursor: 123, scrollFraction: 0.5 } },
    };
    ui.set(state);
    expect(ui.get()).toEqual(state);
  });

  it('accepts a partial state (forward/backward compatible)', () => {
    ui.set({ sideWidth: 400 });
    expect(ui.get()).toEqual({ sideWidth: 400 });
  });

  it('rejects invalid payloads loudly', () => {
    expect(() => ui.set({ navWidth: 'wide' } as never)).toThrow();
    expect(() =>
      ui.set({ documents: { d: { scrollFraction: 2 } } } as never),
    ).toThrow();
  });

  it('degrades to empty state on a corrupt blob', () => {
    ctx.db
      .prepare("INSERT INTO settings (key, value) VALUES ('ui.state', ?)")
      .run('{not json');
    expect(ui.get()).toEqual({});
  });
});
