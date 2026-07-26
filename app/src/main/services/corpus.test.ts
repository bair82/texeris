import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, type ProjectContext } from './project';
import { ConversationService } from './conversation';
import { CorpusService } from './corpus';
import { hashText } from './document';
import { makeImageOnlyPdf, makeTextPdf } from './pdf-fixture.test-helper';

describe('CorpusService', () => {
  let root: string;
  let project: ProjectContext;
  let service: CorpusService;
  let conversationId: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-corpus-'));
    project = createProject(path.join(root, 'project'));
    service = new CorpusService();
    conversationId = new ConversationService(project.db).startNewConversation({ id: 'writing-profile', version: 1 });
  });

  afterEach(() => {
    project.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const storeDir = () => path.join(project.root, '.texeris', 'corpus');
  const rowCount = (table: string) =>
    (project.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const sourceRow = (sourceId: string) =>
    project.db
      .prepare('SELECT snapshot_path, markdown_path, source_hash FROM corpus_sources WHERE id = ?')
      .get(sourceId) as { snapshot_path: string; markdown_path: string; source_hash: string };

  it('snapshots Markdown recursively, detects dates, and survives deletion of the original', async () => {
    const sourceDir = path.join(root, 'writing');
    fs.mkdirSync(path.join(sourceDir, 'nested'), { recursive: true });
    const source = path.join(sourceDir, 'essay-2019.md');
    fs.writeFileSync(source, '---\ndate: 2019-04-02\n---\n\n# Essay\n\nOriginal voice.\n');
    fs.writeFileSync(path.join(sourceDir, '.ignored.md'), 'hidden');
    fs.writeFileSync(path.join(sourceDir, 'nested', 'notes.txt'), 'Notes from 2020.');
    const grant = await service.createGrant(project, conversationId, [sourceDir], 'folder');

    expect(grant.sources).toHaveLength(2);
    expect(grant.sources.find((item) => item.originalPath === source)?.detectedDate).toBe('2019-04-02');
    const row = sourceRow(grant.sources[0].id);
    expect(row.snapshot_path.startsWith(path.join(storeDir(), 'snapshots'))).toBe(true);
    expect(fs.existsSync(row.snapshot_path)).toBe(true);

    // Snapshot semantics: the original is provenance only — changing or
    // deleting it must not affect reads.
    fs.appendFileSync(source, '\nchanged');
    fs.rmSync(grant.sources[1].originalPath);
    const read = await service.read(project, grant.grantId, grant.sources[0].id, 0, 1000);
    expect(read.text).toContain('Original voice.');
  });

  it('rebuilds a missing derivative from the snapshot', async () => {
    const source = path.join(root, 'notes.md');
    fs.writeFileSync(source, '# Rebuild me\n');
    const grant = await service.createGrant(project, conversationId, [source], 'files');
    const row = sourceRow(grant.sources[0].id);
    fs.rmSync(row.markdown_path);
    const read = await service.read(project, grant.grantId, grant.sources[0].id, 0, 1000);
    expect(read.text).toContain('Rebuild me');
    expect(fs.existsSync(row.markdown_path)).toBe(true);
  });

  it('rejects a tampered snapshot', async () => {
    const source = path.join(root, 'notes.md');
    fs.writeFileSync(source, '# Untampered\n');
    const grant = await service.createGrant(project, conversationId, [source], 'files');
    fs.writeFileSync(sourceRow(grant.sources[0].id).snapshot_path, 'tampered');
    await expect(service.read(project, grant.grantId, grant.sources[0].id, 0, 1000))
      .rejects.toThrow(/snapshot failed integrity validation/);
  });

  it('keeps legacy rows (no snapshot) on the original-path behavior', async () => {
    const source = path.join(root, 'legacy.md');
    fs.writeFileSync(source, 'legacy body\n');
    const legacyDir = path.join(root, 'legacy-cache');
    fs.mkdirSync(legacyDir);
    const markdownPath = path.join(legacyDir, 'document.md');
    fs.writeFileSync(markdownPath, 'legacy body\n');
    const bytes = fs.readFileSync(source);
    const grantId = randomUUID();
    project.db
      .prepare('INSERT INTO corpus_grants (id, conversation_id, created_at, source_kind) VALUES (?, ?, ?, ?)')
      .run(grantId, conversationId, new Date().toISOString(), 'files');
    const sourceId = randomUUID();
    project.db
      .prepare(
        `INSERT INTO corpus_sources
         (id, grant_id, original_path, canonical_path, source_hash, source_size,
          source_mtime, format, markdown_path, markdown_hash, converter, snapshot_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        sourceId,
        grantId,
        source,
        fs.realpathSync(source),
        createHash('sha256').update(bytes).digest('hex'),
        bytes.length,
        new Date().toISOString(),
        'md',
        markdownPath,
        hashText('legacy body\n'),
        'direct-utf8-v1',
      );

    const read = await service.read(project, grantId, sourceId, 0, 1000);
    expect(read.text).toBe('legacy body\n');
    fs.appendFileSync(source, 'changed');
    await expect(service.read(project, grantId, sourceId, 0, 1000))
      .rejects.toThrow(/changed after corpus selection/);
  });

  it('records an unavailable conversion instead of aborting the corpus', async () => {
    const source = path.join(root, 'paper.docx');
    fs.writeFileSync(source, 'not really a docx');
    const grant = await service.createGrant(project, conversationId, [source], 'files');
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
    const grant = await service.createGrant(project, conversationId, [textPdf, scanPdf], 'files');
    const textSource = grant.sources.find((source) => source.originalPath === textPdf)!;
    const scanSource = grant.sources.find((source) => source.originalPath === scanPdf)!;
    expect(textSource.warnings).toEqual([expect.stringMatching(/lossy/i)]);
    const derivative = (await service.read(project, grant.grantId, textSource.id, 0, 10_000)).text;
    expect(derivative).toContain('<!-- texeris:pdf-page=1 -->');
    expect(derivative).toContain('<!-- texeris:pdf-page=2 -->');
    expect(scanSource.warnings.join(' ')).toMatch(/OCR is not supported/i);
  });

  it('rejects an over-limit selection without writing any rows', async () => {
    const dir = path.join(root, 'many');
    fs.mkdirSync(dir);
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(dir, `f${i}.md`), `file ${i}`);
    }
    const limited = new CorpusService({ limits: { maxFiles: 2 } });
    await expect(limited.createGrant(project, conversationId, [dir], 'folder'))
      .rejects.toThrow(/2-file limit/);
    expect(rowCount('corpus_grants')).toBe(0);
    expect(rowCount('corpus_sources')).toBe(0);
  });

  it('rejects an over-bytes selection without writing any rows', async () => {
    const dir = path.join(root, 'big');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'a.md'), 'x'.repeat(64));
    fs.writeFileSync(path.join(dir, 'b.md'), 'y'.repeat(64));
    const limited = new CorpusService({ limits: { maxTotalBytes: 100 } });
    await expect(limited.createGrant(project, conversationId, [dir], 'folder'))
      .rejects.toThrow(/total size limit/);
    expect(rowCount('corpus_grants')).toBe(0);
    expect(rowCount('corpus_sources')).toBe(0);
  });

  it('skips oversized files with a warning instead of aborting', async () => {
    const small = path.join(root, 'small.md');
    const large = path.join(root, 'large.md');
    fs.writeFileSync(small, 'ok');
    fs.writeFileSync(large, 'x'.repeat(64));
    const limited = new CorpusService({ limits: { maxFileBytes: 16 } });
    const grant = await limited.createGrant(project, conversationId, [small, large], 'files');
    expect(grant.sources).toHaveLength(1);
    expect(grant.sources[0].originalPath).toBe(small);
    expect(grant.warnings.join(' ')).toMatch(/skipped .*large\.md/);
  });

  it('deleteGrant removes rows, releases the conversation, and GCs unshared blobs', async () => {
    const shared = path.join(root, 'shared.md');
    const onlyB = path.join(root, 'only-b.md');
    fs.writeFileSync(shared, 'identical content');
    fs.writeFileSync(onlyB, 'only in grant B');
    const conversations = new ConversationService(project.db);
    const otherConversation = conversations.startNewConversation({ id: 'writing-profile', version: 1 });
    const grantA = await service.createGrant(project, conversationId, [shared], 'files');
    const grantB = await service.createGrant(project, otherConversation, [shared, onlyB], 'files');

    const sharedRow = sourceRow(grantA.sources[0].id);
    expect(service.listGrants(project)).toHaveLength(2);

    service.deleteGrant(project, grantA.grantId);
    expect(service.listGrants(project)).toHaveLength(1);
    // Shared blob survives: grant B still references the same source hash.
    expect(fs.existsSync(sharedRow.snapshot_path)).toBe(true);
    expect(
      (project.db.prepare('SELECT corpus_grant_id FROM conversations WHERE id = ?').get(conversationId) as {
        corpus_grant_id: string | null;
      }).corpus_grant_id,
    ).toBeNull();

    service.deleteGrant(project, grantB.grantId);
    expect(service.listGrants(project)).toHaveLength(0);
    expect(fs.existsSync(sharedRow.snapshot_path)).toBe(false);
    expect(fs.existsSync(path.join(storeDir(), 'derivatives', sharedRow.source_hash))).toBe(false);
  });

  it('listGrants summarizes grants for the settings UI', async () => {
    const source = path.join(root, 'essay.md');
    fs.writeFileSync(source, 'twelve chars');
    const grant = await service.createGrant(project, conversationId, [source], 'files');
    const grants = service.listGrants(project);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      grantId: grant.grantId,
      conversationId,
      conversationTitle: 'Build writing profile',
      sourceCount: 1,
      totalBytes: 12,
    });
  });

  it('conversation deletion triggers corpus GC of orphaned blobs', async () => {
    const source = path.join(root, 'orphan.md');
    fs.writeFileSync(source, 'orphaned soon');
    const conversations = new ConversationService(project.db, () => service.gc(project));
    const grant = await service.createGrant(project, conversationId, [source], 'files');
    const row = sourceRow(grant.sources[0].id);
    expect(fs.existsSync(row.snapshot_path)).toBe(true);

    conversations.deleteConversation(conversationId);
    expect(rowCount('corpus_grants')).toBe(0);
    expect(fs.existsSync(row.snapshot_path)).toBe(false);
    expect(fs.existsSync(path.join(storeDir(), 'derivatives', row.source_hash))).toBe(false);
  });
});
