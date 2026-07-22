import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, type ProjectContext } from './project';
import { ConversationService } from './conversation';
import { CorpusService } from './corpus';
import { makeImageOnlyPdf, makeTextPdf } from './pdf-fixture.test-helper';

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

  it('snapshots Markdown recursively, detects dates, and rejects changed sources', async () => {
    const sourceDir = path.join(root, 'writing');
    fs.mkdirSync(path.join(sourceDir, 'nested'), { recursive: true });
    const source = path.join(sourceDir, 'essay-2019.md');
    fs.writeFileSync(source, '---\ndate: 2019-04-02\n---\n\n# Essay\n\nOriginal voice.\n');
    fs.writeFileSync(path.join(sourceDir, '.ignored.md'), 'hidden');
    fs.writeFileSync(path.join(sourceDir, 'nested', 'notes.txt'), 'Notes from 2020.');
    const conversations = new ConversationService(project.db);
    const conversationId = conversations.startNewConversation({ id: 'writing-profile', version: 1 });
    const service = new CorpusService(cache);
    const grant = await service.createGrant(project, conversationId, [sourceDir], 'folder');

    expect(grant.sources).toHaveLength(2);
    expect(grant.sources.find((item) => item.originalPath === source)?.detectedDate).toBe('2019-04-02');
    const read = service.read(project, grant.grantId, grant.sources[0].id, 0, 1000);
    expect(read.text.length).toBeGreaterThan(0);

    fs.appendFileSync(grant.sources[0].originalPath, '\nchanged');
    expect(() => service.read(project, grant.grantId, grant.sources[0].id, 0, 1000)).toThrow(/changed after corpus selection/);
  });

  it('records an unavailable conversion instead of aborting the corpus', async () => {
    const source = path.join(root, 'paper.docx');
    fs.writeFileSync(source, 'not really a docx');
    const conversationId = new ConversationService(project.db).startNewConversation({ id: 'writing-profile', version: 1 });
    const grant = await new CorpusService(cache).createGrant(project, conversationId, [source], 'files');
    expect(grant.sources[0].warnings.join(' ')).toMatch(/Pandoc|conversion/i);
  });

  it('extracts PDF corpus text with page provenance and records scans as warnings', async () => {
    const textPdf = path.join(root, 'paper.pdf');
    const scanPdf = path.join(root, 'scan.pdf');
    fs.writeFileSync(textPdf, makeTextPdf([
      Array(7).fill('First page of a corpus paper with selectable academic prose.').join('\n'),
      Array(7).fill('Second page preserves page-level provenance for later reports.').join('\n'),
    ]));
    fs.writeFileSync(scanPdf, makeImageOnlyPdf());
    const conversationId = new ConversationService(project.db).startNewConversation({ id: 'writing-profile', version: 1 });
    const service = new CorpusService(cache);
    const grant = await service.createGrant(project, conversationId, [textPdf, scanPdf], 'files');
    const textSource = grant.sources.find((source) => source.originalPath === textPdf)!;
    const scanSource = grant.sources.find((source) => source.originalPath === scanPdf)!;
    expect(textSource.warnings).toEqual([expect.stringMatching(/lossy/i)]);
    const derivative = service.read(project, grant.grantId, textSource.id, 0, 10_000).text;
    expect(derivative).toContain('<!-- texeris:pdf-page=1 -->');
    expect(derivative).toContain('<!-- texeris:pdf-page=2 -->');
    expect(scanSource.warnings.join(' ')).toMatch(/OCR is not supported/i);
  });
});
