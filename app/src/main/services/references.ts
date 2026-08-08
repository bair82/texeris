import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  CitationAudit,
  CslName,
  CslReference,
  ReferenceCreateResult,
  ReferenceDraft,
  ReferenceImportReport,
  ReferenceKind,
  ReferenceListItem,
} from '../../shared/reference-types';
import { atomicWriteText, hashText } from './document';
import { importBibliography } from './pandoc';
import type { ProjectContext } from './project';

export const REFERENCES_FILE = 'references.csl.json';
const doiRecordCache = new Map<string, CslReference>();

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function firstText(value: unknown): string {
  return Array.isArray(value) ? text(value[0]) : text(value);
}

export function normalizeDoi(value: string): string {
  let doi = value.trim();
  doi = doi.replace(/^doi:\s*/i, '');
  try {
    if (/^https?:\/\//i.test(doi)) {
      const parsed = new URL(doi);
      if (/^(?:dx\.)?doi\.org$/i.test(parsed.hostname)) {
        doi = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
      }
    }
  } catch {
    // The shape check below provides the user-facing validation error.
  }
  if (!/^10\.\d{4,9}\/\S+$/i.test(doi)) {
    throw new Error('Enter a DOI such as 10.1000/example');
  }
  return doi.toLocaleLowerCase();
}

function normalizedDoiOrEmpty(value: unknown): string {
  const doi = text(value);
  if (!doi) return '';
  try {
    return normalizeDoi(doi);
  } catch {
    return '';
  }
}

function crossrefType(value: unknown): ReferenceKind {
  switch (text(value)) {
    case 'journal-article':
      return 'article-journal';
    case 'book':
    case 'book-set':
    case 'edited-book':
    case 'monograph':
    case 'reference-book':
      return 'book';
    case 'book-chapter':
    case 'book-part':
    case 'book-section':
    case 'reference-entry':
      return 'chapter';
    case 'proceedings-article':
      return 'paper-conference';
    case 'dissertation':
      return 'thesis';
    case 'report':
      return 'report';
    case 'posted-content':
    case 'peer-review':
    case 'journal-issue':
      return 'article-journal';
    default:
      return 'document';
  }
}

function crossrefIssued(message: Record<string, unknown>): CslReference['issued'] {
  for (const field of ['published-print', 'published-online', 'published', 'issued', 'created']) {
    const date = record(message[field]);
    const parts = date?.['date-parts'];
    if (
      Array.isArray(parts) &&
      Array.isArray(parts[0]) &&
      typeof parts[0][0] === 'number'
    ) {
      return { 'date-parts': [parts[0] as number[]] };
    }
  }
  return undefined;
}

/** Convert the bounded Crossref fields useful to CSL without retaining abstracts. */
export function crossrefMessageToReference(
  value: unknown,
  requestedDoi: string,
): CslReference {
  const message = record(value);
  if (!message) throw new Error('Crossref returned invalid metadata');
  const title = firstText(message.title);
  if (!title) throw new Error('Crossref has no title for this DOI');
  const authors = Array.isArray(message.author)
    ? message.author
        .map((value): CslName | null => {
          const author = record(value);
          if (!author) return null;
          const family = text(author.family);
          const given = text(author.given);
          const literal = text(author.name);
          if (!family && !given && !literal) return null;
          return literal ? { literal } : { family, given };
        })
        .filter((author): author is CslName => Boolean(author))
    : [];
  const issued = crossrefIssued(message);
  const reference: CslReference = {
    id: '',
    type: crossrefType(message.type),
    title,
    ...(authors.length ? { author: authors } : {}),
    ...(issued ? { issued } : {}),
    DOI: normalizeDoi(text(message.DOI) || requestedDoi),
  };
  const scalarFields: Array<[keyof CslReference, unknown]> = [
    ['container-title', firstText(message['container-title'])],
    ['publisher', message.publisher],
    ['publisher-place', message['publisher-location']],
    ['volume', message.volume],
    ['issue', message.issue],
    ['page', message.page],
    ['URL', message.URL],
    ['language', message.language],
  ];
  for (const [key, raw] of scalarFields) {
    const value = text(raw);
    if (value) reference[key] = value;
  }
  for (const [key, raw] of [
    ['ISSN', message.ISSN],
    ['ISBN', message.ISBN],
  ] as const) {
    if (Array.isArray(raw)) {
      const values = raw.map(text).filter(Boolean);
      if (values.length) reference[key] = values;
    }
  }
  return reference;
}

function formAuthors(names: CslName[] | undefined): string {
  return (names ?? [])
    .map((name) =>
      name.literal ?? [name.given, name.family].filter(Boolean).join(' '),
    )
    .filter(Boolean)
    .join('; ');
}

function parseAuthors(value: string): CslName[] {
  return value
    .split(/[;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((name) => {
      const comma = name.indexOf(',');
      if (comma >= 0) {
        return {
          family: name.slice(0, comma).trim(),
          given: name.slice(comma + 1).trim(),
        };
      }
      const parts = name.split(/\s+/);
      return parts.length === 1
        ? { literal: name }
        : { family: parts.at(-1), given: parts.slice(0, -1).join(' ') };
    });
}

function keyPart(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9]+/g, '')
    .toLocaleLowerCase();
}

function suggestedKey(draft: Pick<ReferenceDraft, 'authors' | 'year' | 'title'>): string {
  const firstAuthor = draft.authors.split(/[;\n]+/)[0]?.trim() ?? '';
  const family = firstAuthor.includes(',')
    ? firstAuthor.split(',')[0]
    : firstAuthor.split(/\s+/).at(-1) ?? '';
  const author = keyPart(family);
  const year = /^\d{1,4}$/.test(draft.year.trim()) ? draft.year.trim() : '';
  const title = keyPart(draft.title.split(/\s+/).find((word) => word.length > 3) ?? '');
  return `${author || title || 'ref'}${year}`;
}

function draftFromReference(reference: CslReference): ReferenceDraft {
  return {
    citationKey: suggestedKey({
      authors: formAuthors(reference.author),
      year: issuedYear(reference),
      title: text(reference.title),
    }),
    type: (reference.type ?? 'document') as ReferenceKind,
    title: text(reference.title),
    authors: formAuthors(reference.author),
    year: issuedYear(reference),
    doi: text(reference.DOI),
    url: text(reference.URL),
  };
}

function validWebUrl(value: string): string {
  if (!value.trim()) return '';
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
    return url.toString();
  } catch {
    throw new Error('URL must start with http:// or https://');
  }
}

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

  async lookupDoi(value: string): Promise<ReferenceDraft> {
    const doi = normalizeDoi(value);
    const cached = doiRecordCache.get(doi);
    if (cached) return draftFromReference(cached);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const encodedDoi = doi.split('/').map(encodeURIComponent).join('/');
      const response = await fetch(`https://api.crossref.org/works/${encodedDoi}`, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Texeris/0.1 (https://github.com/bair82/texeris)',
        },
      });
      if (response.status === 404) {
        throw new Error(
          'No Crossref record was found. You can still enter the details manually.',
        );
      }
      if (!response.ok) {
        throw new Error(
          'Crossref is temporarily unavailable. You can still enter the details manually.',
        );
      }
      const envelope = record(await response.json());
      const reference = crossrefMessageToReference(envelope?.message, doi);
      doiRecordCache.set(doi, reference);
      return draftFromReference(reference);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(
          'DOI lookup timed out. You can still enter the details manually.',
        );
      }
      if (
        error instanceof Error &&
        (error.message.startsWith('No Crossref') ||
          error.message.startsWith('Crossref'))
      ) {
        throw error;
      }
      throw new Error(
        'DOI lookup could not connect. You can still enter the details manually.',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  create(draft: ReferenceDraft): ReferenceCreateResult {
    const title = draft.title.trim();
    if (!title) throw new Error('Title is required');
    const year = draft.year.trim();
    if (year && !/^\d{1,4}$/.test(year)) {
      throw new Error('Year must contain one to four digits');
    }
    const doi = draft.doi.trim() ? normalizeDoi(draft.doi) : '';
    const key = draft.citationKey.trim().replace(/^@/, '');
    if (key && !/^[A-Za-z0-9_:.#$%&+?<>~/=-]+$/.test(key)) {
      throw new Error('Citation key cannot contain spaces, brackets, commas, or semicolons');
    }
    const current = this.read();
    if (doi) {
      const existing = current.find(
        (reference) => normalizedDoiOrEmpty(reference.DOI) === doi,
      );
      if (existing) {
        return {
          item: display(existing),
          created: false,
          warnings: [`@${existing.id} already uses this DOI.`],
        };
      }
    }

    const cached = doi ? doiRecordCache.get(doi) : undefined;
    const reference: CslReference = cached
      ? structuredClone(cached)
      : { id: '', type: draft.type };
    reference.id = key || suggestedKey(draft);
    reference.type = draft.type;
    reference.title = title;
    const authors = parseAuthors(draft.authors);
    if (authors.length) reference.author = authors;
    else delete reference.author;
    if (year) reference.issued = { 'date-parts': [[Number(year)]] };
    else delete reference.issued;
    if (doi) reference.DOI = doi;
    else delete reference.DOI;
    const url = validWebUrl(draft.url);
    if (url) reference.URL = url;
    else delete reference.URL;

    const report = this.importRecords([reference], 'manual entry');
    const finalKey =
      report.renamed.find(({ from }) => from === reference.id)?.to ??
      reference.id;
    const item = this.list().find((candidate) => candidate.key === finalKey);
    if (!item) throw new Error('Reference was saved but could not be indexed');
    return {
      item,
      created: true,
      warnings: [
        ...report.renamed.map(
          ({ from, to }) => `Citation key @${from} was already used; saved as @${to}.`,
        ),
        ...report.warnings,
      ],
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
