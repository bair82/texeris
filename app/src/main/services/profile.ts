import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ActiveWritingProfile, ProfileActivateRequest } from '../../shared/profile-types';
import type { WritingProfileView } from '../../shared/settings-types';
import type { ProjectContext } from './project';
import type { WorkspaceConfig } from './settings';
import { saveWorkspaceConfig, workspaceDir } from './settings';
import { atomicWriteText } from './document';

const ARTIFACTS = [
  ['writing-style-report', 'writing-style-report.md'],
  ['writing-profile', 'writing-profile.md'],
  ['intellectual-profile', 'intellectual-profile.md'],
] as const;

export class WritingProfileService {
  constructor(
    private readonly config: WorkspaceConfig,
    private readonly dir = workspaceDir(),
  ) {}

  activate(project: ProjectContext, input: ProfileActivateRequest): ActiveWritingProfile {
    const ids = [
      input.reportDocumentId,
      input.writingProfileDocumentId,
      input.intellectualProfileDocumentId,
    ];
    const profileId = randomUUID();
    const profileDir = path.join(this.dir, 'profiles', profileId);
    fs.mkdirSync(profileDir, { recursive: true });
    const activatedAt = new Date().toISOString();
    const artifacts = ARTIFACTS.map(([kind, filename], index) => {
      const documentId = ids[index];
      const row = project.db
        .prepare('SELECT path, current_revision FROM documents WHERE id = ? AND trashed_at IS NULL')
        .get(documentId) as { path: string; current_revision: number } | undefined;
      if (!row) throw new Error(`profile artifact document is unavailable: ${documentId}`);
      const content = project.revisions.getCurrentText(documentId);
      atomicWriteText(path.join(profileDir, filename), content);
      return { kind, documentId, path: row.path, revision: row.current_revision };
    });
    const manifest: ActiveWritingProfile = {
      id: profileId,
      activatedAt,
      sourceProject: project.root,
      artifacts,
    };
    atomicWriteText(path.join(profileDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    this.config.activeProfileId = profileId;
    saveWorkspaceConfig(this.config, this.dir);
    return manifest;
  }

  disable(): void {
    this.config.activeProfileId = null;
    saveWorkspaceConfig(this.config, this.dir);
  }

  active(): ActiveWritingProfile | null {
    const id = this.config.activeProfileId;
    if (!id) return null;
    try {
      return JSON.parse(
        fs.readFileSync(path.join(this.dir, 'profiles', id, 'manifest.json'), 'utf8'),
      ) as ActiveWritingProfile;
    } catch {
      return null;
    }
  }

  view(): WritingProfileView {
    const active = this.active();
    return {
      enabled: active !== null,
      activeProfileId: active?.id ?? null,
      activatedAt: active?.activatedAt ?? null,
      sourceProject: active?.sourceProject ?? null,
    };
  }

  read(kind: 'writing-profile' | 'writing-style-report' | 'intellectual-profile'): string | null {
    const id = this.config.activeProfileId;
    if (!id) return null;
    const file = path.join(this.dir, 'profiles', id, `${kind}.md`);
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }
}
