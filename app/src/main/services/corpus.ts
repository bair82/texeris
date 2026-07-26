import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CorpusGrantView, CorpusSourceView } from '../../shared/profile-types';
import type { ProjectContext } from './project';
import { atomicWriteBytes, atomicWriteText, hashText } from './document';
import { convertToMarkdown, PANDOC_VERSION } from './pandoc';
import { extractPdfText, pdfCorpusMarkdown, PDF_EXTRACTOR_VERSION } from './pdf';

const SUPPORTED = new Set(['.md', '.markdown', '.mdown', '.txt', '.html', '.htm', '.docx', '.odt', '.rtf', '.pdf']);

/** Walk/selection limits (owner decision 2026-07-26): a grant is all-or-
 * nothing — exceeding the file count or total bytes aborts with an error;
 * a single oversized file is skipped with a warning instead. */
export interface CorpusLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  maxDepth: number;
}

const DEFAULT_LIMITS: CorpusLimits = {
  maxFiles: 200,
  maxTotalBytes: 500 * 1024 * 1024,
  maxFileBytes: 100 * 1024 * 1024,
  maxDepth: 8,
};

export interface CorpusOptions {
  /** Resolve the per-project corpus store; defaults to <root>/.texeris/corpus. */
  storeDir?: (project: ProjectContext) => string;
  /** Test override for the selection limits. */
  limits?: Partial<CorpusLimits>;
}

interface Converted {
  markdown: string;
  converter: string;
  warnings: string[];
}

interface WalkedFile {
  path: string;
  size: number;
  mtime: string;
}

/**
 * Corpus grants use immutable snapshot semantics: source bytes are copied
 * into project-owned storage (<root>/.texeris/corpus) at grant time and
 * later reads never touch the original path. Legacy rows (snapshot_path
 * NULL) keep the old re-read-the-original behavior.
 */
export class CorpusService {
  private readonly storeDir: (project: ProjectContext) => string;
  private readonly limits: CorpusLimits;

  constructor(options: CorpusOptions = {}) {
    this.storeDir = options.storeDir ?? ((project) => path.join(project.root, '.texeris', 'corpus'));
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  async createGrant(
    project: ProjectContext,
    conversationId: string,
    selectedPaths: readonly string[],
    sourceKind: 'files' | 'folder',
  ): Promise<{ grantId: string; sources: CorpusSourceView[]; warnings: string[] }> {
    const { files, warnings } = this.walk(selectedPaths);
    if (files.length === 0) throw new Error('no supported writing files were selected');
    const store = this.storeDir(project);
    const snapshotsDir = path.join(store, 'snapshots');
    const derivativesDir = path.join(store, 'derivatives');
    fs.mkdirSync(snapshotsDir, { recursive: true });

    // Convert everything first; the DB rows land in ONE transaction at the
    // end so a failure can never leave a partial grant.
    interface PendingRow {
      id: string;
      file: WalkedFile;
      sourceHash: string;
      snapshotPath: string;
      markdownPath: string;
      markdownHash: string;
      converter: string;
      detected: { date: string; confidence: string } | null;
      conversionWarnings: string[];
    }
    const pending: PendingRow[] = [];
    for (const file of files) {
      const bytes = fs.readFileSync(file.path);
      const sourceHash = createHash('sha256').update(bytes).digest('hex');
      const snapshotPath = path.join(snapshotsDir, `${sourceHash}${path.extname(file.path).toLowerCase()}`);
      // Content-addressed: an identical source granted before is reused.
      if (!fs.existsSync(snapshotPath)) {
        atomicWriteBytes(snapshotPath, bytes);
      }
      const converted = await convert(file.path, bytes);
      const derivativeDir = path.join(derivativesDir, sourceHash);
      fs.mkdirSync(derivativeDir, { recursive: true });
      const markdownPath = path.join(derivativeDir, 'document.md');
      atomicWriteText(markdownPath, converted.markdown);
      pending.push({
        id: randomUUID(),
        file,
        sourceHash,
        snapshotPath,
        markdownPath,
        markdownHash: hashText(converted.markdown),
        converter: converted.converter,
        detected: detectDate(converted.markdown, path.basename(file.path)),
        conversionWarnings: converted.warnings,
      });
    }

    const grantId = randomUUID();
    project.db.exec('BEGIN');
    try {
      project.db
        .prepare('INSERT INTO corpus_grants (id, conversation_id, created_at, source_kind) VALUES (?, ?, ?, ?)')
        .run(grantId, conversationId, new Date().toISOString(), sourceKind);
      const insert = project.db.prepare(
        `INSERT INTO corpus_sources
         (id, grant_id, original_path, canonical_path, source_hash, source_size,
          source_mtime, format, markdown_path, markdown_hash, converter,
          detected_date, date_confidence, conversion_warnings_json, snapshot_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const row of pending) {
        insert.run(
          row.id,
          grantId,
          row.file.path,
          fs.realpathSync(row.file.path),
          row.sourceHash,
          row.file.size,
          row.file.mtime,
          path.extname(row.file.path).slice(1).toLowerCase(),
          row.markdownPath,
          row.markdownHash,
          row.converter,
          row.detected?.date ?? null,
          row.detected?.confidence ?? null,
          JSON.stringify(row.conversionWarnings),
          row.snapshotPath,
        );
      }
      project.db
        .prepare('UPDATE conversations SET corpus_grant_id = ? WHERE id = ?')
        .run(grantId, conversationId);
      project.db.exec('COMMIT');
    } catch (err) {
      project.db.exec('ROLLBACK');
      throw err;
    }
    // Stray on-disk blobs from a failed grant are collected by gc().
    return {
      grantId,
      warnings,
      sources: pending.map((row) => ({
        id: row.id,
        originalPath: row.file.path,
        format: path.extname(row.file.path).slice(1).toLowerCase(),
        size: row.file.size,
        modifiedAt: row.file.mtime,
        detectedDate: row.detected?.date ?? null,
        dateConfidence: row.detected?.confidence ?? null,
        warnings: row.conversionWarnings,
      })),
    };
  }

  grantForConversation(project: ProjectContext, conversationId: string): string | null {
    const row = project.db
      .prepare('SELECT corpus_grant_id FROM conversations WHERE id = ?')
      .get(conversationId) as { corpus_grant_id: string | null } | undefined;
    return row?.corpus_grant_id ?? null;
  }

  list(project: ProjectContext, grantId: string): CorpusSourceView[] {
    const rows = project.db
      .prepare(
        `SELECT id, original_path, format, source_size, source_mtime, detected_date,
                date_confidence, conversion_warnings_json
         FROM corpus_sources WHERE grant_id = ? ORDER BY original_path`,
      )
      .all(grantId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      originalPath: row.original_path as string,
      format: row.format as string,
      size: row.source_size as number,
      modifiedAt: row.source_mtime as string,
      detectedDate: row.detected_date as string | null,
      dateConfidence: row.date_confidence as string | null,
      warnings: JSON.parse(row.conversion_warnings_json as string) as string[],
    }));
  }

  /** Per-grant summary for the settings UI (JOIN conversations). */
  listGrants(project: ProjectContext): CorpusGrantView[] {
    const rows = project.db
      .prepare(
        `SELECT g.id, g.conversation_id, c.title, g.created_at,
                COUNT(s.id) AS source_count, COALESCE(SUM(s.source_size), 0) AS total_bytes
         FROM corpus_grants g
         JOIN conversations c ON c.id = g.conversation_id
         LEFT JOIN corpus_sources s ON s.grant_id = g.id
         GROUP BY g.id
         ORDER BY g.created_at DESC, g.rowid DESC`,
      )
      .all() as Array<{
      id: string;
      conversation_id: string;
      title: string;
      created_at: string;
      source_count: number;
      total_bytes: number;
    }>;
    return rows.map((row) => ({
      grantId: row.id,
      conversationId: row.conversation_id,
      conversationTitle: row.title,
      createdAt: row.created_at,
      sourceCount: row.source_count,
      totalBytes: row.total_bytes,
    }));
  }

  async read(project: ProjectContext, grantId: string, sourceId: string, offset: number, limit: number) {
    const row = project.db
      .prepare(
        `SELECT original_path, markdown_path, source_hash, markdown_hash, snapshot_path
         FROM corpus_sources WHERE id = ? AND grant_id = ?`,
      )
      .get(sourceId, grantId) as
      | {
          original_path: string;
          markdown_path: string;
          source_hash: string;
          markdown_hash: string;
          snapshot_path: string | null;
        }
      | undefined;
    if (!row) throw new Error('source is not part of this conversation corpus');

    let text: string;
    if (row.snapshot_path) {
      // Snapshot semantics: the original path is provenance only, never read.
      const snapshotBytes = fs.readFileSync(row.snapshot_path);
      const snapshotHash = createHash('sha256').update(snapshotBytes).digest('hex');
      if (snapshotHash !== row.source_hash) {
        throw new Error('corpus snapshot failed integrity validation');
      }
      if (fs.existsSync(row.markdown_path)) {
        text = fs.readFileSync(row.markdown_path, 'utf8');
        if (hashText(text) !== row.markdown_hash) {
          throw new Error('cached conversion failed integrity validation');
        }
      } else {
        // The derivative is disposable — rebuild it from the snapshot.
        text = await this.rebuildDerivative(project, sourceId, row, snapshotBytes);
      }
    } else {
      // Legacy row: re-read and re-hash the original file on every read.
      const currentHash = createHash('sha256').update(fs.readFileSync(row.original_path)).digest('hex');
      if (currentHash !== row.source_hash) throw new Error('source changed after corpus selection; start a new profile run');
      text = fs.readFileSync(row.markdown_path, 'utf8');
      if (hashText(text) !== row.markdown_hash) throw new Error('cached conversion failed integrity validation');
    }
    const start = Math.min(offset, text.length);
    const end = Math.min(start + limit, text.length);
    return { sourceId, offset: start, end, totalChars: text.length, text: text.slice(start, end) };
  }

  private async rebuildDerivative(
    project: ProjectContext,
    sourceId: string,
    row: { original_path: string; markdown_path: string; markdown_hash: string },
    snapshotBytes: Buffer,
  ): Promise<string> {
    const converted = await convert(row.original_path, snapshotBytes);
    fs.mkdirSync(path.dirname(row.markdown_path), { recursive: true });
    atomicWriteText(row.markdown_path, converted.markdown);
    const markdownHash = hashText(converted.markdown);
    if (markdownHash !== row.markdown_hash) {
      project.db
        .prepare('UPDATE corpus_sources SET markdown_hash = ? WHERE id = ?')
        .run(markdownHash, sourceId);
    }
    return converted.markdown;
  }

  /** Delete one grant's rows and release the conversation reference, then GC. */
  deleteGrant(project: ProjectContext, grantId: string): void {
    project.db.exec('BEGIN');
    try {
      project.db.prepare('DELETE FROM corpus_sources WHERE grant_id = ?').run(grantId);
      project.db.prepare('DELETE FROM corpus_grants WHERE id = ?').run(grantId);
      project.db
        .prepare('UPDATE conversations SET corpus_grant_id = NULL WHERE corpus_grant_id = ?')
        .run(grantId);
      project.db.exec('COMMIT');
    } catch (err) {
      project.db.exec('ROLLBACK');
      throw err;
    }
    this.gc(project);
  }

  /**
   * Remove snapshot blobs and derivative directories whose source hash is no
   * longer referenced by any corpus_sources row in this project. Best-effort:
   * failures are logged, never thrown.
   */
  gc(project: ProjectContext): void {
    try {
      const referenced = new Set(
        (
          project.db
            .prepare('SELECT DISTINCT source_hash FROM corpus_sources')
            .all() as Array<{ source_hash: string }>
        ).map((row) => row.source_hash),
      );
      const store = this.storeDir(project);
      const snapshotsDir = path.join(store, 'snapshots');
      if (fs.existsSync(snapshotsDir)) {
        for (const entry of fs.readdirSync(snapshotsDir)) {
          // Snapshot files are named <sha256><ext>; the hash is 64 hex chars.
          if (!referenced.has(entry.slice(0, 64))) {
            fs.rmSync(path.join(snapshotsDir, entry), { force: true });
          }
        }
      }
      const derivativesDir = path.join(store, 'derivatives');
      if (fs.existsSync(derivativesDir)) {
        for (const entry of fs.readdirSync(derivativesDir)) {
          if (!referenced.has(entry)) {
            fs.rmSync(path.join(derivativesDir, entry), { recursive: true, force: true });
          }
        }
      }
    } catch (err) {
      console.warn('corpus gc failed; unreferenced blobs were kept', err);
    }
  }

  private walk(selected: readonly string[]): { files: WalkedFile[]; warnings: string[] } {
    const files = new Map<string, WalkedFile>();
    const warnings: string[] = [];
    let totalBytes = 0;
    const visit = (entry: string, depth: number): void => {
      const stat = fs.lstatSync(entry);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        if (depth >= this.limits.maxDepth) return;
        for (const child of fs.readdirSync(entry, { withFileTypes: true })) {
          if (child.name.startsWith('.')) continue;
          visit(path.join(entry, child.name), depth + 1);
        }
        return;
      }
      if (stat.isFile() && SUPPORTED.has(path.extname(entry).toLowerCase())) {
        const real = fs.realpathSync(entry);
        if (files.has(real)) return;
        if (stat.size > this.limits.maxFileBytes) {
          warnings.push(
            `skipped ${entry}: larger than the ${Math.round(this.limits.maxFileBytes / (1024 * 1024))} MB per-file limit`,
          );
          return;
        }
        files.set(real, { path: real, size: stat.size, mtime: stat.mtime.toISOString() });
        totalBytes += stat.size;
        if (files.size > this.limits.maxFiles) {
          throw new Error(`corpus selection exceeds the ${this.limits.maxFiles}-file limit`);
        }
        if (totalBytes > this.limits.maxTotalBytes) {
          throw new Error(
            `corpus selection exceeds the ${Math.round(this.limits.maxTotalBytes / (1024 * 1024))} MB total size limit`,
          );
        }
      }
    };
    selected.forEach((entry) => visit(entry, 0));
    return { files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)), warnings };
  }
}

async function convert(file: string, bytes: Buffer): Promise<Converted> {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.md' || ext === '.markdown' || ext === '.mdown' || ext === '.txt') {
    return { markdown: bytes.toString('utf8'), converter: 'direct-utf8-v1', warnings: [] };
  }
  if (ext === '.pdf') {
    try {
      const extracted = await extractPdfText(bytes);
      return {
        markdown: pdfCorpusMarkdown(extracted),
        converter: extracted.converter,
        warnings: extracted.warnings,
      };
    } catch (error) {
      return {
        markdown: '',
        converter: `${PDF_EXTRACTOR_VERSION}-failed`,
        warnings: [`PDF conversion failed: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
  }
  try {
    return convertToMarkdown(file, bytes);
  } catch (error) {
    return {
      markdown: '',
      converter: `pandoc-${PANDOC_VERSION}-failed`,
      warnings: [`Pandoc conversion failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

function detectDate(text: string, filename: string): { date: string; confidence: string } | null {
  const frontmatter = text.slice(0, 4000).match(/^---\s*[\s\S]*?^date:\s*["']?([^\n"']+)/m);
  if (frontmatter) return { date: frontmatter[1].trim(), confidence: 'explicit-metadata' };
  const nameYear = filename.match(/(?:^|\D)((?:19|20)\d{2})(?:\D|$)/);
  if (nameYear) return { date: nameYear[1], confidence: 'filename-year' };
  const published = text.slice(0, 8000).match(/(?:published|publication date)\s*[:—-]\s*([^\n]+)/i);
  return published ? { date: published[1].trim(), confidence: 'publication-statement' } : null;
}
