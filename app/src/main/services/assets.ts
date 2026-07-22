import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { applySplices } from '../../shared/text-splice';

const ASSET_ROOT = 'assets';
const ASSET_TRASH = '.texeris/asset-trash';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_EXTENSION = /\.(?:avif|gif|jpe?g|png|svg|webp)$/i;

const MIME_EXTENSIONS: Record<string, string> = {
  'image/avif': '.avif',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

export interface AddedImageAsset {
  path: string;
  alt: string;
}

function documentPath(db: DatabaseSync, documentId: string): string {
  const row = db
    .prepare('SELECT path, trashed_at FROM documents WHERE id = ?')
    .get(documentId) as { path: string; trashed_at: string | null } | undefined;
  if (!row) throw new Error(`unknown document: ${documentId}`);
  if (row.trashed_at !== null) throw new Error('cannot add an image to a trashed document');
  return row.path;
}

function cleanStem(sourceName: string): string {
  const stem = path.basename(sourceName, path.extname(sourceName)).trim();
  const safe = stem
    .normalize('NFKD')
    .replace(/[^\w-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return safe || 'image';
}

/**
 * Persist renderer-supplied image bytes inside this document's media folder.
 * Content hashes make retries and repeated clipboard events idempotent.
 */
export function addImageAsset(
  root: string,
  db: DatabaseSync,
  input: { documentId: string; sourceName: string; mediaType: string; dataBase64: string },
): AddedImageAsset {
  const extension = MIME_EXTENSIONS[input.mediaType.toLowerCase()];
  if (!extension) throw new Error('use a PNG, JPEG, GIF, WebP, or AVIF image');
  const bytes = Buffer.from(input.dataBase64, 'base64');
  if (bytes.length === 0) throw new Error('the image is empty');
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('images must be 20 MB or smaller');
  // Buffer's base64 decoder is permissive; re-encoding catches malformed IPC data.
  if (bytes.toString('base64') !== input.dataBase64.replace(/\s/g, '')) {
    throw new Error('invalid image data');
  }

  const docPath = documentPath(db, input.documentId);
  const stem = cleanStem(input.sourceName);
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  const relative = path.posix.join(
    ASSET_ROOT,
    path.basename(docPath, '.md'),
    'media',
    `${stem}-${hash}${extension}`,
  );
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target)) {
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temp, bytes, { flag: 'wx' });
      fs.renameSync(temp, target);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
  return {
    path: relative,
    alt: path.basename(input.sourceName, path.extname(input.sourceName)).trim(),
  };
}

function referencedAssets(text: string): Set<string> {
  const found = new Set<string>();
  // Canonical Markdown and controlled HTML both leave project asset paths
  // visible. Authored names contain no whitespace; imported Pandoc media use
  // the same project-relative shape.
  for (const match of text.matchAll(/(?:^|[\s("'])((?:assets)\/[^\s)"'<>]+)/gim)) {
    const relative = match[1].replace(/\\/g, '/');
    if (
      IMAGE_EXTENSION.test(relative) &&
      !relative.split('/').includes('..') &&
      relative.startsWith(`${ASSET_ROOT}/`)
    ) {
      found.add(relative);
    }
  }
  return found;
}

function walkImages(root: string, relative = ''): string[] {
  const dir = path.join(root, ...relative.split('/').filter(Boolean));
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...walkImages(root, child));
    else if (entry.isFile() && IMAGE_EXTENSION.test(entry.name)) out.push(child);
  }
  return out;
}

function moveAsset(fromRoot: string, toRoot: string, relative: string): void {
  const from = path.join(fromRoot, ...relative.split('/'));
  const to = path.join(toRoot, ...relative.split('/'));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.existsSync(to)) fs.rmSync(to, { force: true });
  fs.renameSync(from, to);
}

function removeEmptyDirs(dir: string, stopAt: string): void {
  let current = dir;
  while (current.startsWith(`${stopAt}${path.sep}`) && current !== stopAt) {
    if (!fs.existsSync(current) || fs.readdirSync(current).length > 0) return;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

/**
 * Keep only currently referenced files in the public assets tree. Files that
 * an earlier revision can restore are held in hidden asset trash; true
 * orphans are deleted. This makes image deletion economical without breaking
 * revision restore.
 */
export function reconcileImageAssets(root: string, db: DatabaseSync): void {
  const publicRoot = path.join(root, ASSET_ROOT);
  const trashRoot = path.join(root, ASSET_TRASH);
  const publicFiles = walkImages(publicRoot);
  const hiddenFiles = walkImages(trashRoot);
  if (publicFiles.length === 0 && hiddenFiles.length === 0) return;

  const live = new Set<string>();
  const docs = db
    .prepare('SELECT path FROM documents WHERE trashed_at IS NULL')
    .all() as Array<{ path: string }>;
  for (const doc of docs) {
    const file = path.join(root, doc.path);
    if (fs.existsSync(file)) {
      for (const ref of referencedAssets(fs.readFileSync(file, 'utf8'))) live.add(ref);
    }
  }

  // The overwhelmingly common autosave path: every public asset is still
  // referenced and there is nothing waiting in hidden trash. Avoid replaying
  // revision history on each typing group.
  if (
    hiddenFiles.length === 0 &&
    publicFiles.every((relative) => live.has(path.posix.join(ASSET_ROOT, relative)))
  ) return;

  const historical = new Set(live);
  const documentIds = db.prepare('SELECT id FROM documents').all() as Array<{ id: string }>;
  for (const { id } of documentIds) {
    const changes = db
      .prepare(
        `SELECT seq, from_off, to_off, deleted_text, inserted_text
         FROM revision_changes WHERE document_id = ? ORDER BY seq, idx`,
      )
      .all(id) as Array<{
      seq: number;
      from_off: number;
      to_off: number;
      deleted_text: string;
      inserted_text: string;
    }>;
    let text = '';
    let at = 0;
    while (at < changes.length) {
      const seq = changes[at].seq;
      let end = at + 1;
      while (end < changes.length && changes[end].seq === seq) end += 1;
      text = applySplices(
        text,
        changes.slice(at, end).map((change) => ({
          from: change.from_off,
          to: change.to_off,
          deletedText: change.deleted_text,
          insertedText: change.inserted_text,
        })),
      );
      for (const ref of referencedAssets(text)) historical.add(ref);
      at = end;
    }
  }

  for (const relativeBelowAssets of publicFiles) {
    const relative = path.posix.join(ASSET_ROOT, relativeBelowAssets);
    if (live.has(relative)) continue;
    const source = path.join(publicRoot, ...relativeBelowAssets.split('/'));
    if (historical.has(relative)) moveAsset(root, trashRoot, relative);
    else fs.rmSync(source, { force: true });
    removeEmptyDirs(path.dirname(source), publicRoot);
  }
  for (const relative of hiddenFiles) {
    const hidden = path.join(trashRoot, ...relative.split('/'));
    if (live.has(relative)) {
      moveAsset(trashRoot, root, relative);
      removeEmptyDirs(path.dirname(hidden), trashRoot);
    } else if (!historical.has(relative)) {
      fs.rmSync(hidden, { force: true });
      removeEmptyDirs(path.dirname(hidden), trashRoot);
    }
  }
}

/** Cleanup follows successful document writes and must never turn their ack
 * into a false failure. A later commit/project open retries any incomplete
 * reconciliation. */
export function reconcileImageAssetsBestEffort(
  root: string,
  db: DatabaseSync,
): void {
  try {
    reconcileImageAssets(root, db);
  } catch (error) {
    console.warn('image asset reconciliation failed; it will be retried', error);
  }
}
