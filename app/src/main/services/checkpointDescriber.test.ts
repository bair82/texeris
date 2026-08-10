import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createModels } from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxProviderHandle,
} from '@earendil-works/pi-ai/providers/faux';
import { CheckpointService } from './checkpoint';
import { CheckpointDescriber } from './checkpointDescriber';
import { createProject, ensureDocument, type ProjectContext } from './project';
import { DEFAULT_CONFIG, type WorkspaceConfig } from './settings';

let root: string;
let ctx: ProjectContext;
let checkpoints: CheckpointService;
let faux: FauxProviderHandle;
let docId: string;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function configWith(overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  return {
    ...DEFAULT_CONFIG,
    modes: {
      fast: { provider: 'faux', model: 'faux-model' },
      deep: { provider: 'faux', model: 'faux-model' },
    },
    ...overrides,
  };
}

function makeDescriber(
  config: WorkspaceConfig,
  onUpdated?: (checkpointId: string) => void,
): CheckpointDescriber {
  const models = createModels();
  models.setProvider(faux.provider);
  return new CheckpointDescriber({
    db: ctx.db,
    checkpoints,
    models,
    config,
    onUpdated,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-desc-'));
  ctx = createProject(root);
  checkpoints = new CheckpointService(ctx.db, ctx.revisions);
  faux = fauxProvider({ models: [{ id: 'faux-model' }] });
  docId = ensureDocument(ctx, 'manuscript.md');
  ctx.revisions.commit(
    docId,
    [{ from: 0, to: 0, deletedText: '', insertedText: '# Notes\n\nThe quick brown fox.\n' }],
    { actor: 'user', source: { kind: 'typing' } },
  );
});

afterEach(() => {
  ctx.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('CheckpointDescriber', () => {
  it('rewrites the fallback description with the fast model reply', async () => {
    faux.setResponses([fauxAssistantMessage('Introduced the fox paragraph.')]);
    const updated = new Promise<string>((resolve) => {
      const describer = makeDescriber(configWith(), resolve);
      const cp = checkpoints.create(docId);
      expect(cp.description).toContain('chars in'); // deterministic fallback first
      describer.schedule(cp.id);
    });
    await updated;
    const cp = checkpoints.list(docId)[0];
    // sanitized: single line, no trailing period
    expect(cp.description).toBe('Introduced the fox paragraph');
  });

  it('keeps the fallback when the feature is disabled', async () => {
    faux.setResponses([fauxAssistantMessage('should not be used')]);
    const describer = makeDescriber(configWith({ llmCheckpointDescriptions: false }));
    const cp = checkpoints.create(docId);
    describer.schedule(cp.id);
    await sleep(150);
    expect(checkpoints.list(docId)[0].description).toBe(cp.description);
  });

  it('keeps the fallback when the provider fails', async () => {
    // empty faux queue → every request errors
    const describer = makeDescriber(configWith());
    const cp = checkpoints.create(docId);
    describer.schedule(cp.id);
    await sleep(200);
    expect(checkpoints.list(docId)[0].description).toBe(cp.description);
  });
});
