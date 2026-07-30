import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArchiveService } from './archive';
import { CorpusService } from './corpus';
import { ConversationService } from './conversation';
import { createProject, type ProjectContext } from './project';

describe('ArchiveService', () => {
  let root: string;
  let workspace: string;
  let service: ArchiveService;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-archive-'));
    workspace = path.join(root, 'workspace');
    service = new ArchiveService({ dir: workspace });
  });

  afterEach(() => {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('imports immutable writing snapshots and searches heading-aware passages', async () => {
    const source = path.join(root, 'paper-2024.md');
    fs.writeFileSync(
      source,
      '# Geometry of Attention\n\n## Method\n\nWe compare geodesic distances between attention heads.\n\n' +
        'The manifold interpretation makes alignment measurable.\n',
    );
    const report = await service.importPaths([source]);
    expect(report).toMatchObject({ imported: 1, duplicates: 0, skipped: 0 });
    expect(service.list()).toEqual([
      expect.objectContaining({
        title: 'Geometry of Attention',
        originalPath: source,
        format: 'md',
        status: 'current',
        passageCount: 1,
      }),
    ]);

    const results = service.search('geodesic attention');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: 'Geometry of Attention',
      heading: 'Method',
      page: null,
    });
    expect(results[0].excerpt).toContain('‹geodesic›');
    expect(service.search('(geodesic), attention!')).toHaveLength(1);
    const attached = service.passages([results[0].passageId]);
    expect(attached[0].excerpt).toContain('geodesic distances');
    expect(attached[0].excerpt).not.toContain('‹');

    fs.writeFileSync(source, '# Changed\n');
    expect(service.list()[0].status).toBe('changed');
    const preview = service.preview(results[0].sourceId);
    expect(preview.text).toContain('manifold interpretation');
    expect(preview.source.status).toBe('changed');
  });

  it('deduplicates by content and removes the managed snapshot predictably', async () => {
    const first = path.join(root, 'first.md');
    const second = path.join(root, 'second.md');
    fs.writeFileSync(first, '# Same\n\nIdentical prior work.');
    fs.writeFileSync(second, '# Same\n\nIdentical prior work.');
    expect(await service.importPaths([first, second])).toMatchObject({
      imported: 1,
      duplicates: 1,
    });
    const [source] = service.list();
    const managed = service.corpusSources([source.id])[0].snapshotPath;
    expect(fs.existsSync(managed)).toBe(true);
    fs.appendFileSync(managed, '\ntampered');
    expect(() => service.corpusSources([source.id])).toThrow(/integrity validation/);
    service.delete(source.id);
    expect(service.list()).toEqual([]);
    expect(service.search('identical')).toEqual([]);
    expect(fs.existsSync(managed)).toBe(false);
  });

  it('rebuilds a corrupted search projection without changing passage ids', async () => {
    const source = path.join(root, 'repair-me.md');
    fs.writeFileSync(source, '# Repair Me\n\nThe orrery makes attention geometry visible.\n');
    await service.importPaths([source]);
    const [before] = service.search('orrery');

    const db = new DatabaseSync(path.join(workspace, 'archive', 'archive.sqlite'));
    try {
      db.exec('DELETE FROM archive_fts');
      db.prepare(
        `INSERT INTO archive_fts
         (passage_id, source_id, title, heading, text) VALUES (?, ?, ?, ?, ?)`,
      ).run(before.passageId, before.sourceId, 'Wrong title', '', 'phantom index text');
    } finally {
      db.close();
    }

    expect(service.search('orrery')).toEqual([]);
    expect(service.search('phantom')).toHaveLength(1);

    await expect(service.reindex()).resolves.toEqual({ sources: 1, passages: 1 });
    expect(service.search('phantom')).toEqual([]);
    expect(service.search('orrery')[0]).toMatchObject({
      passageId: before.passageId,
      sourceId: before.sourceId,
      title: 'Repair Me',
    });
  });

  it('reuses selected archived snapshots for a project writing-profile grant', async () => {
    const source = path.join(root, 'voice.md');
    fs.writeFileSync(source, '# Voice\n\nA restrained analytical sentence.');
    await service.importPaths([source]);
    const archived = service.list()[0];

    const project: ProjectContext = createProject(path.join(root, 'project'));
    try {
      const conversations = new ConversationService(project.db);
      const conversationId = conversations.startNewConversation({
        id: 'writing-profile',
        version: 1,
      });
      const corpus = new CorpusService();
      const grant = await corpus.createGrantFromArchive(
        project,
        conversationId,
        service.corpusSources([archived.id]),
      );
      expect(grant.sources[0]).toMatchObject({
        originalPath: source,
        format: 'md',
      });
      const read = await corpus.read(
        project,
        grant.grantId,
        grant.sources[0].id,
        0,
        1000,
      );
      expect(read.text).toContain('restrained analytical sentence');
    } finally {
      project.db.close();
    }
  });
});
