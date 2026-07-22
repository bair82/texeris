import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, type ProjectContext } from './project';
import { createGeneratedDocument } from './documents';
import { WritingProfileService } from './profile';
import { DEFAULT_CONFIG, type WorkspaceConfig } from './settings';

describe('WritingProfileService', () => {
  let root: string;
  let workspace: string;
  let project: ProjectContext;
  let config: WorkspaceConfig;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-profile-'));
    workspace = path.join(root, 'config');
    fs.mkdirSync(workspace, { recursive: true });
    project = createProject(path.join(root, 'project'));
    config = structuredClone(DEFAULT_CONFIG);
  });

  afterEach(() => {
    project.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('atomically activates immutable snapshots and can disable them', () => {
    const origin = { conversationId: 'conv', agentRunId: 'run' };
    const report = createGeneratedDocument(project, 'writing-style-report.md', '# Report\nEvidence.', origin);
    const writing = createGeneratedDocument(project, 'writing-profile.md', '# Voice\nConcise.', origin);
    const intellectual = createGeneratedDocument(project, 'intellectual-profile.md', '# Outlook\nConditional.', origin);
    const service = new WritingProfileService(config, workspace);
    const active = service.activate(project, {
      reportDocumentId: report.id,
      writingProfileDocumentId: writing.id,
      intellectualProfileDocumentId: intellectual.id,
    });

    expect(service.read('writing-profile')).toContain('Concise');
    expect(service.view()).toMatchObject({ enabled: true, activeProfileId: active.id });
    expect(fs.existsSync(path.join(workspace, 'profiles', active.id, 'manifest.json'))).toBe(true);
    service.disable();
    expect(service.view().enabled).toBe(false);
    expect(fs.existsSync(path.join(workspace, 'profiles', active.id, 'writing-profile.md'))).toBe(true);
  });
});
