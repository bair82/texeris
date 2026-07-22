import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteText } from './document';
import { createProject, openProject, type ProjectContext } from './project';
import { workspaceDir } from './settings';

/**
 * Project lifecycle: the app works on one project at a time. The manager
 * owns the current ProjectContext, a recents list (workspace config dir),
 * and open/create flows. Switching projects rebinds main-process services;
 * the renderer reloads on the project:changed event.
 */
export class ProjectManager {
  current: ProjectContext | null = null;

  constructor(private readonly recentsFile = path.join(workspaceDir(), 'recents.json')) {}

  open(root: string): ProjectContext {
    const ctx = openProject(root);
    this.adopt(ctx);
    return ctx;
  }

  create(parentDir: string, name: string): ProjectContext {
    const trimmed = name.trim();
    if (
      !trimmed ||
      trimmed === '.' ||
      trimmed === '..' ||
      trimmed.includes('..') ||
      path.isAbsolute(trimmed) ||
      trimmed.includes('/') ||
      trimmed.includes('\\')
    ) {
      throw new Error(`invalid project name ${JSON.stringify(name)}`);
    }
    const root = path.join(parentDir, trimmed);
    const ctx = createProject(root);
    this.adopt(ctx);
    return ctx;
  }

  /** Adopt an externally built context (e.g. the dev-project harness). */
  adoptContext(ctx: ProjectContext): ProjectContext {
    this.adopt(ctx);
    return ctx;
  }

  recents(): string[] {
    try {
      const list = JSON.parse(fs.readFileSync(this.recentsFile, 'utf8')) as string[];
      return list.filter((p) => fs.existsSync(path.join(p, '.texeris', 'project.json')));
    } catch {
      return [];
    }
  }

  private adopt(ctx: ProjectContext): void {
    this.current?.db.close();
    this.current = ctx;
    this.pushRecent(ctx.root);
  }

  private pushRecent(root: string): void {
    const list = [root, ...this.recents().filter((p) => p !== root)].slice(0, 8);
    fs.mkdirSync(path.dirname(this.recentsFile), { recursive: true });
    atomicWriteText(this.recentsFile, JSON.stringify(list, null, 2) + '\n');
  }
}
