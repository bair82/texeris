import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, type ProjectContext } from './project';
import { ConversationService } from './conversation';
import { CorpusService } from './corpus';

describe('CorpusService', () => {
  let root: string;
  let cache: string;
  let project: ProjectContext;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-corpus-'));
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-corpus-cache-'));
    project = createProject(path.join(root, 'project'));
  });

  afterEach(() => {
    project.db.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cache, { recursive: true, force: true });
  });

  it('snapshots Markdown recursively, detects dates, and rejects changed sources', () => {
    const sourceDir = path.join(root, 'writing');
    fs.mkdirSync(path.join(sourceDir, 'nested'), { recursive: true });
    const source = path.join(sourceDir, 'essay-2019.md');
    fs.writeFileSync(source, '---\ndate: 2019-04-02\n---\n\n# Essay\n\nOriginal voice.\n');
    fs.writeFileSync(path.join(sourceDir, '.ignored.md'), 'hidden');
    fs.writeFileSync(path.join(sourceDir, 'nested', 'notes.txt'), 'Notes from 2020.');
    const conversations = new ConversationService(project.db);
    const conversationId = conversations.startNewConversation({ id: 'writing-profile', version: 1 });
    const service = new CorpusService(cache);
    const grant = service.createGrant(project, conversationId, [sourceDir], 'folder');

    expect(grant.sources).toHaveLength(2);
    expect(grant.sources.find((item) => item.originalPath === source)?.detectedDate).toBe('2019-04-02');
    const read = service.read(project, grant.grantId, grant.sources[0].id, 0, 1000);
    expect(read.text.length).toBeGreaterThan(0);

    fs.appendFileSync(grant.sources[0].originalPath, '\nchanged');
    expect(() => service.read(project, grant.grantId, grant.sources[0].id, 0, 1000)).toThrow(/changed after corpus selection/);
  });

  it('records an unavailable conversion instead of aborting the corpus', () => {
    const source = path.join(root, 'paper.docx');
    fs.writeFileSync(source, 'not really a docx');
    const conversationId = new ConversationService(project.db).startNewConversation({ id: 'writing-profile', version: 1 });
    const grant = new CorpusService(cache).createGrant(project, conversationId, [source], 'files');
    expect(grant.sources[0].warnings.join(' ')).toMatch(/Pandoc|conversion/i);
  });
});
