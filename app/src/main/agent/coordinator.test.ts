import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { createProject } from '../services/project';
import { DEFAULT_CONFIG } from '../services/settings';
import { ConversationService } from '../services/conversation';
import { AgentCoordinator } from './coordinator';

describe('AgentCoordinator', () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

  it('runs an isolated child and persists its structured result', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-child-'));
    roots.push(root);
    const project = createProject(root);
    const conversations = new ConversationService(project.db);
    const conversationId = conversations.startNewConversation();
    const faux = fauxProvider({ models: [{ id: 'faux-model' }] });
    faux.setResponses([fauxAssistantMessage('Evidence summary from child.')]);
    const models = createModels();
    models.setProvider(faux.provider);
    const config = structuredClone(DEFAULT_CONFIG);
    config.modes.fast = { provider: 'faux', model: 'faux-model' };
    const events: string[] = [];
    const coordinator = new AgentCoordinator({
      models, config, db: project.db,
      onEvent: (event) => events.push(event.type),
    });
    const result = await coordinator.delegate({
      parentRunId: 'parent', conversationId, role: 'metadata-researcher', task: 'Find the date.', tools: [],
    });
    expect(result).toMatchObject({ status: 'completed', summary: 'Evidence summary from child.' });
    expect(events).toEqual(['delegation_start', 'delegation_end']);
    expect(conversations.listDelegations(conversationId)[0].summary).toBe('Evidence summary from child.');
    project.db.close();
  });
});
