import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  CitationAudit,
  CslName,
  CslReference,
  ReferenceImportReport,
  ReferenceListItem,
} from '../../shared/reference-types';
import { atomicWriteText, hashText } from './document';
import { importBibliography } from './pandoc';
import type { ProjectContext } from './project';

export const REFERENCES_FILE = 'references.csl.json';

function authorText(names: CslName[] | undefined): string {
  return (names ?? [])
    .map((name) => name.literal ?? [name.family, name.given].filter(Boolean).join(', '))
    .filter(Boolean)
    .join('; ');
}

function issuedYear(reference: CslReference): string {
  const value = reference.issued?.['date-parts']?.[0]?.[0];
  return value === undefined ? '' : String(value);
}

function display(reference: CslReference): ReferenceListItem {
  return {
    key: reference.id,
    title: typeof reference.title === 'string' ? reference.title : 'Untitled reference',
    authors: authorText(Array.isArray(reference.author) ? reference.author : undefined),
    year: issuedYear(reference),
    type: typeof reference.type === 'string' ? reference.type : 'document',
  };
}

function parseLibrary(raw: string): CslReference[] {
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value)) throw new Error(`${REFERENCES_FILE} must contain a JSON array`);
  const keys = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`reference ${index + 1} must be a JSON object`);
    }
    const reference = item as CslReference;
    if (typeof reference.id !== 'string' || !reference.id.trim()) {
      throw new Error(`reference ${index + 1} has no citation key`);
    }
    reference.id = reference.id.trim();
    if (keys.has(reference.id)) throw new Error(`duplicate citation key: ${reference.id}`);
    keys.add(reference.id);
    return reference;
  });
}

function citedKeys(markdown: string): string[] {
  const keys = new Set<string>();
  for (const match of markdown.matchAll(/(^|[\s[(;])-?@([A-Za-z0-9_:.#$%&+?<>~/=-]+)/g)) {
    keys.add(match[2]);
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}

/** Canonical CSL JSON file with a rebuildable SQLite search projection. */
export class ReferenceService {
  readonly filePath: string;

  constructor(private readonly project: ProjectContext) {
    this.filePath = path.join(project.root, REFERENCES_FILE);
    if (!fs.existsSync(this.filePath)) atomicWriteText(this.filePath, '[]\n');
  }

  list(): ReferenceListItem[] {
    this.syncIndex();
    return (
      this.project.db
        .prepare(
          `SELECT citation_key, title, authors, issued_year, record_json
           FROM reference_index ORDER BY authors COLLATE NOCASE, issued_year, title COLLATE NOCASE`,
        )
        .all() as Array<{
        citation_key: string;
        title: string;
        authors: string;
        issued_year: string;
        record_json: string;
      }>
    ).map((row) => ({
      key: row.citation_key,
      title: row.title,
      authors: row.authors,
      year: row.issued_year,
      type: (JSON.parse(row.record_json) as CslReference).type ?? 'document',
    }));
  }

  search(query: string, limit = 30): ReferenceListItem[] {
    const items = this.list();
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return items.slice(0, limit);
    return items
      .map((item) => {
        const key = item.key.toLocaleLowerCase();
        const title = item.title.toLocaleLowerCase();
        const haystack = `${key} ${title} ${item.authors} ${item.year}`.toLocaleLowerCase();
        if (!terms.every((term) => haystack.includes(term))) return null;
        const score =
          (key.startsWith(terms[0]) ? 4 : 0) +
          (title.startsWith(terms[0]) ? 2 : 0) +
          terms.filter((term) => key.includes(term)).length;
        return { item, score };
      })
      .filter((entry): entry is { item: ReferenceListItem; score: number } => Boolean(entry))
      .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title))
      .slice(0, limit)
      .map((entry) => entry.item);
  }

  audit(markdown: string): CitationAudit {
    const cited = citedKeys(markdown);
    const library = new Set(this.list().map((item) => item.key));
    return {
      citedKeys: cited,
      unresolvedKeys: cited.filter((key) => !library.has(key)),
      unusedKeys: [...library].filter((key) => !cited.includes(key)).sort(),
    };
  }

  importRecords(records: CslReference[], sourceName: string): ReferenceImportReport {
    const current = this.read();
    const byKey = new Map(current.map((reference) => [reference.id, reference]));
    const fingerprints = new Set(current.map((reference) => this.fingerprint(reference)).filter(Boolean));
    const renamed: ReferenceImportReport['renamed'] = [];
    const warnings: string[] = [];
    let imported = 0;
    let skipped = 0;

    for (const candidate of records) {
      const parsed = parseLibrary(JSON.stringify([candidate]))[0];
      const existing = byKey.get(parsed.id);
      if (existing && JSON.stringify(existing) === JSON.stringify(parsed)) {
        skipped += 1;
        continue;
      }
      if (existing) {
        const from = parsed.id;
        let counter = 2;
        while (byKey.has(`${from}-${counter}`)) counter += 1;
        parsed.id = `${from}-${counter}`;
        renamed.push({ from, to: parsed.id });
      }
      const fingerprint = this.fingerprint(parsed);
      if (fingerprint && fingerprints.has(fingerprint)) {
        warnings.push(`${parsed.id} may duplicate an existing reference.`);
      }
      current.push(parsed);
      byKey.set(parsed.id, parsed);
      if (fingerprint) fingerprints.add(fingerprint);
      imported += 1;
    }
    this.write(current);
    return {
      imported,
      skipped,
      renamed,
      warnings,
      total: current.length,
      sourceName,
    };
  }

  async importFile(fileName: string, signal?: AbortSignal): Promise<ReferenceImportReport> {
    const extension = path.extname(fileName).toLowerCase();
    let records: CslReference[];
    if (extension === '.json') {
      records = parseLibrary(fs.readFileSync(fileName, 'utf8'));
    } else if (extension === '.bib' || extension === '.bibtex') {
      records = await importBibliography(fileName, 'bibtex', signal);
    } else if (extension === '.ris') {
      records = await importBibliography(fileName, 'ris', signal);
    } else {
      throw new Error('choose a CSL JSON, BibTeX, or RIS bibliography');
    }
    return this.importRecords(records, path.basename(fileName));
  }

  read(): CslReference[] {
    return parseLibrary(fs.readFileSync(this.filePath, 'utf8'));
  }

  private write(records: CslReference[]): void {
    atomicWriteText(this.filePath, `${JSON.stringify(records, null, 2)}\n`);
    this.rebuildIndex(records, hashText(fs.readFileSync(this.filePath, 'utf8')));
  }

  private syncIndex(): void {
    const raw = fs.readFileSync(this.filePath, 'utf8');
    const hash = hashText(raw);
    const indexed = this.project.db
      .prepare(`SELECT value FROM meta WHERE key = 'references_hash'`)
      .get() as { value: string } | undefined;
    if (indexed?.value !== hash) this.rebuildIndex(parseLibrary(raw), hash);
  }

  private rebuildIndex(records: CslReference[], hash: string): void {
    this.project.db.exec('BEGIN');
    try {
      this.project.db.exec('DELETE FROM reference_index');
      const insert = this.project.db.prepare(
        `INSERT INTO reference_index
           (citation_key, title, authors, issued_year, doi, record_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const reference of records) {
        const item = display(reference);
        insert.run(
          item.key,
          item.title,
          item.authors,
          item.year,
          typeof reference.DOI === 'string' ? reference.DOI : null,
          JSON.stringify(reference),
        );
      }
      this.project.db
        .prepare(
          `INSERT INTO meta(key, value) VALUES ('references_hash', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(hash);
      this.project.db.exec('COMMIT');
    } catch (error) {
      this.project.db.exec('ROLLBACK');
      throw error;
    }
  }

  private fingerprint(reference: CslReference): string {
    const doi = typeof reference.DOI === 'string' ? reference.DOI.trim().toLowerCase() : '';
    if (doi) return `doi:${doi.replace(/^https?:\/\/doi\.org\//, '')}`;
    const title = typeof reference.title === 'string'
      ? reference.title.toLocaleLowerCase().replace(/\W+/gu, ' ').trim()
      : '';
    return title ? `title:${title}:${issuedYear(reference)}` : '';
  }
}
