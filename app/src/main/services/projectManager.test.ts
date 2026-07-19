import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectManager } from './projectManager';

let dir: string;
let recentsFile: string;
let manager: ProjectManager;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-pm-'));
  recentsFile = path.join(dir, 'recents.json');
  manager = new ProjectManager(recentsFile);
});

afterEach(() => {
  manager.current?.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ProjectManager', () => {
  it('creates a project and records it in recents', () => {
    const ctx = manager.create(dir, 'paper');
    expect(ctx.project.mainDocument).toBe('manuscript.md');
    expect(manager.current?.root).toBe(path.join(dir, 'paper'));
    expect(manager.recents()).toEqual([path.join(dir, 'paper')]);
  });

  it('opens an existing project and orders recents most-recent-first', () => {
    manager.create(dir, 'one');
    manager.create(dir, 'two');
    expect(manager.recents()).toEqual([path.join(dir, 'two'), path.join(dir, 'one')]);

    const reopened = new ProjectManager(recentsFile);
    const ctx = reopened.open(path.join(dir, 'one'));
    expect(ctx.project.projectId).toBe(manager.recents().includes(path.join(dir, 'one'))
      ? reopened.current?.project.projectId
      : undefined);
    expect(reopened.recents()[0]).toBe(path.join(dir, 'one'));
    reopened.current?.db.close();
  });

  it('rejects invalid project names', () => {
    expect(() => manager.create(dir, '../escape')).toThrow(/invalid project name/);
    expect(() => manager.create(dir, '/absolute')).toThrow(/invalid project name/);
  });

  it('skips recents whose project folder vanished', () => {
    manager.create(dir, 'gone');
    fs.rmSync(path.join(dir, 'gone'), { recursive: true, force: true });
    expect(manager.recents()).toEqual([]);
  });
});
