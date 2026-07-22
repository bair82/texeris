import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { createProject, ensureDocument, type ProjectContext } from '../services/project';
import { PatchService } from '../services/patch';
import { WritingProfileService } from '../services/profile';
import { DEFAULT_CONFIG, type WorkspaceConfig } from '../services/settings';
import { PatchStyleGate } from './styleCritic';

describe('PatchStyleGate', () => {
  let root: string;
  let project: ProjectContext;
  let config: WorkspaceConfig;
  let patches: PatchService;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-critic-'));
    project = createProject(path.join(root, 'project'));
    const doc = ensureDocument(project, 'manuscript.md');
    project.revisions.commit(doc, [{ from: 0, to: 0, deletedText: '', insertedText: 'The claim is narrow.\n' }], { actor: 'user', source: { kind: 'typing' } });
    config = structuredClone(DEFAULT_CONFIG);
    config.modes.fast = { provider: 'faux', model: 'faux-model' };
    patches = new PatchService(project.db, project.revisions);
  });

  afterEach(() => {
    project.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('attaches an audit without altering the patch', async () => {
    config.patchStyleMode = 'audit';
    const faux = fauxProvider({ models: [{ id: 'faux-model' }] });
    faux.setResponses([fauxAssistantMessage('{"verdict":"pass","issues":[]}')]);
    const models = createModels();
    models.setProvider(faux.provider);
    const gate = new PatchStyleGate({ models, config, patches, profiles: new WritingProfileService(config, path.join(root, 'config')) });
    const doc = ensureDocument(project, 'manuscript.md');
    const result = await gate.propose('run', 'tighten prose', {
      documentId: doc, baseRevision: 1, title: 'Edit', summary: 'Tighten',
      groups: [{ explanation: 'clarity', changes: [{ expectedText: 'narrow', insert: 'precise' }] }],
    }, { conversationId: 'conv', agentRunId: 'run' });
    expect(result.kind).toBe('stored');
    expect(patches.list(doc)[0].styleReview).toMatchObject({ verdict: 'pass', mode: 'audit' });
  });

  it('holds one flagged proposal and releases it when no retry occurs', async () => {
    config.patchStyleMode = 'revise-once';
    const faux = fauxProvider({ models: [{ id: 'faux-model' }] });
    faux.setResponses([fauxAssistantMessage(JSON.stringify({
      verdict: 'revise', issues: [{ groupIndex: 0, changeIndex: 0, category: 'negative_parallelism', span: 'not merely narrow but precise', severity: 'medium', confidence: 'high', reason: 'The contrast is unmotivated.', direction: 'State the positive claim directly.' }],
    }))]);
    const models = createModels();
    models.setProvider(faux.provider);
    const gate = new PatchStyleGate({ models, config, patches, profiles: new WritingProfileService(config, path.join(root, 'config')) });
    const doc = ensureDocument(project, 'manuscript.md');
    const result = await gate.propose('run', 'tighten prose', {
      documentId: doc, baseRevision: 1, title: 'Edit', summary: 'Tighten',
      groups: [{ explanation: 'clarity', changes: [{ expectedText: 'narrow', insert: 'not merely narrow but precise' }] }],
    }, { conversationId: 'conv', agentRunId: 'run' });
    expect(result.kind).toBe('revise');
    expect(patches.list(doc)).toHaveLength(0);
    gate.finalize('run');
    expect(patches.list(doc)[0].styleReview?.verdict).toBe('revise');
  });
});
