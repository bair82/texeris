import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, type ProjectContext } from './project';
import { ReferenceService, REFERENCES_FILE } from './references';

describe('ReferenceService', () => {
  let root: string;
  let project: ProjectContext;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-references-'));
    project = createProject(root);
  });

  afterEach(() => {
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
});
