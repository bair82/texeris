import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject, type ProjectContext } from './project';
import {
  crossrefMessageToReference,
  normalizeDoi,
  ReferenceService,
  REFERENCES_FILE,
} from './references';

describe('ReferenceService', () => {
  let root: string;
  let project: ProjectContext;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-references-'));
    project = createProject(root);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    project.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps canonical CSL JSON searchable and audits citation keys', () => {
    const references = new ReferenceService(project);
    const report = references.importRecords(
      [
        {
          id: 'smith2024',
          type: 'article-journal',
          title: 'Geometry of Attention',
          author: [{ family: 'Smith', given: 'Ada' }],
          issued: { 'date-parts': [[2024]] },
          DOI: '10.1000/example',
        },
        {
          id: 'jones2022',
          title: 'Earlier Work',
          author: [{ family: 'Jones', given: 'Lin' }],
          issued: { 'date-parts': [[2022]] },
        },
      ],
      'library.json',
    );

    expect(report).toMatchObject({ imported: 2, skipped: 0, total: 2 });
    expect(fs.existsSync(path.join(root, REFERENCES_FILE))).toBe(true);
    expect(references.search('smith geometry')).toEqual([
      expect.objectContaining({ key: 'smith2024', year: '2024' }),
    ]);
    expect(references.audit('Claim [@smith2024; @missing, p. 2].')).toEqual({
      citedKeys: ['missing', 'smith2024'],
      unresolvedKeys: ['missing'],
      unusedKeys: ['jones2022'],
    });
  });

  it('preserves conflicting imports under a new key and repairs its index after external edits', () => {
    const references = new ReferenceService(project);
    references.importRecords([{ id: 'same', title: 'First' }], 'first.json');
    const report = references.importRecords(
      [{ id: 'same', title: 'Second' }],
      'second.json',
    );
    expect(report.renamed).toEqual([{ from: 'same', to: 'same-2' }]);

    fs.writeFileSync(
      path.join(root, REFERENCES_FILE),
      `${JSON.stringify([{ id: 'external', title: 'Edited outside Texeris' }], null, 2)}\n`,
    );
    expect(references.list()).toEqual([
      expect.objectContaining({ key: 'external', title: 'Edited outside Texeris' }),
    ]);
  });

  it('rejects malformed or duplicate canonical keys', () => {
    const references = new ReferenceService(project);
    fs.writeFileSync(
      references.filePath,
      JSON.stringify([{ id: 'dup' }, { id: 'dup' }]),
    );
    expect(() => references.list()).toThrow(/duplicate citation key/);
  });

  it('creates a manual reference with an automatic key and reuses an existing DOI', () => {
    const references = new ReferenceService(project);
    const first = references.create({
      citationKey: '',
      type: 'article-journal',
      title: 'A Practical Reference',
      authors: 'Ada Smith; Jones, Lin',
      year: '2026',
      doi: 'https://doi.org/10.5555/Practical',
      url: 'https://example.test/paper',
    });
    expect(first).toMatchObject({
      created: true,
      item: { key: 'smith2026', title: 'A Practical Reference', year: '2026' },
    });
    expect(references.read()).toEqual([
      expect.objectContaining({
        id: 'smith2026',
        DOI: '10.5555/practical',
        URL: 'https://example.test/paper',
        author: [
          { family: 'Smith', given: 'Ada' },
          { family: 'Jones', given: 'Lin' },
        ],
      }),
    ]);

    const duplicate = references.create({
      citationKey: 'different',
      type: 'document',
      title: 'Duplicate DOI',
      authors: '',
      year: '',
      doi: '10.5555/practical',
      url: '',
    });
    expect(duplicate).toMatchObject({
      created: false,
      item: { key: 'smith2026' },
    });
    expect(references.list()).toHaveLength(1);
  });

  it('maps Crossref metadata, caches it, and preserves enriched fields on save', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          message: {
            DOI: '10.5555/lookup',
            type: 'journal-article',
            title: ['Found from a DOI'],
            author: [
              { given: 'Mina', family: 'Lee' },
              { given: 'Omar', family: 'Khan' },
            ],
            issued: { 'date-parts': [[2025, 4, 2]] },
            'container-title': ['Journal of Useful Metadata'],
            volume: '8',
            issue: '2',
            page: '10-19',
            publisher: 'Example Society',
            URL: 'https://doi.org/10.5555/lookup',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const references = new ReferenceService(project);
    const draft = await references.lookupDoi('doi:10.5555/LOOKUP');
    expect(draft).toEqual({
      citationKey: 'lee2025',
      type: 'article-journal',
      title: 'Found from a DOI',
      authors: 'Mina Lee; Omar Khan',
      year: '2025',
      doi: '10.5555/lookup',
      url: 'https://doi.org/10.5555/lookup',
    });
    const created = references.create(draft);
    expect(created.item.key).toBe('lee2025');
    expect(references.read()[0]).toMatchObject({
      'container-title': 'Journal of Useful Metadata',
      volume: '8',
      issue: '2',
      page: '10-19',
      publisher: 'Example Society',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('normalizes DOI URLs and rejects non-DOI input', () => {
    expect(normalizeDoi('https://doi.org/10.1000/ABC')).toBe('10.1000/abc');
    expect(() => normalizeDoi('not a doi')).toThrow(/Enter a DOI/);
    expect(
      crossrefMessageToReference(
        { title: ['A Book'], type: 'monograph', DOI: '10.1000/book' },
        '10.1000/book',
      ),
    ).toMatchObject({ type: 'book', title: 'A Book' });
  });

  it('keeps manual entry available when DOI lookup cannot connect', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(
      new ReferenceService(project).lookupDoi('10.5555/offline'),
    ).rejects.toThrow(/still enter the details manually/);
  });
});
