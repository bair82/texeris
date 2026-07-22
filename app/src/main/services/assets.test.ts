import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { minimalSplice } from '../../shared/text-splice';
import { addImageAsset, reconcileImageAssets } from './assets';
import { createProject, ensureDocument, type ProjectContext } from './project';

let root: string;
let ctx: ProjectContext;
let documentId: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-assets-'));
  ctx = createProject(root);
  fs.writeFileSync(path.join(root, 'paper.md'), '');
  documentId = ensureDocument(ctx, 'paper.md');
});

afterEach(() => {
  ctx.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function add(name = 'Figure One.png') {
  return addImageAsset(root, ctx.db, {
    documentId,
    sourceName: name,
    mediaType: 'image/png',
    dataBase64: Buffer.from('not a real png, but deterministic image bytes').toString('base64'),
  });
}

function commit(text: string, kind: 'typing' | 'paste' = 'paste'): number {
  const current = ctx.revisions.getCurrentRevision(documentId) === 0
    ? ''
    : ctx.revisions.getCurrentText(documentId);
  return ctx.revisions.commit(documentId, [minimalSplice(current, text)], {
    actor: 'user',
    source: { kind },
  });
}

describe('image assets', () => {
  it('writes a hashed, project-relative media file and deduplicates retries', () => {
    const first = add();
    const second = add();
    expect(first).toEqual(second);
    expect(first.path).toMatch(/^assets\/paper\/media\/Figure-One-[a-f0-9]{12}\.png$/);
    expect(first.alt).toBe('Figure One');
    expect(fs.readFileSync(path.join(root, first.path), 'utf8')).toContain('deterministic');
  });

  it('rejects unsupported types and malformed base64', () => {
    expect(() => addImageAsset(root, ctx.db, {
      documentId,
      sourceName: 'vector.svg',
      mediaType: 'image/svg+xml',
      dataBase64: 'PHN2Zz4=',
    })).toThrow(/PNG/);
    expect(() => addImageAsset(root, ctx.db, {
      documentId,
      sourceName: 'bad.png',
      mediaType: 'image/png',
      dataBase64: '%%%%',
    })).toThrow(/empty|invalid/);
  });

  it('deletes an upload that was never referenced', () => {
    const asset = add();
    expect(fs.existsSync(path.join(root, asset.path))).toBe(true);
    reconcileImageAssets(root, ctx.db);
    expect(fs.existsSync(path.join(root, asset.path))).toBe(false);
  });

  it('hides a deleted asset needed by history and restores it with the revision', () => {
    const asset = add();
    const withImage = `Before\n\n![Figure](${asset.path})\n`;
    const imageRevision = commit(withImage);
    expect(fs.existsSync(path.join(root, asset.path))).toBe(true);

    commit('Before\n', 'typing');
    expect(fs.existsSync(path.join(root, asset.path))).toBe(false);
    expect(fs.existsSync(path.join(root, '.texeris', 'asset-trash', asset.path))).toBe(true);

    ctx.revisions.restore(documentId, imageRevision);
    expect(fs.existsSync(path.join(root, asset.path))).toBe(true);
    expect(fs.existsSync(path.join(root, '.texeris', 'asset-trash', asset.path))).toBe(false);
  });

  it('permanently removes assets no actual revision references', () => {
    const asset = add();
    // One amended typing revision: the transient image is not a restorable
    // revision, so the final reconciliation may delete it outright.
    commit(`![Figure](${asset.path})\n`, 'typing');
    commit('No image\n', 'typing');
    expect(fs.existsSync(path.join(root, asset.path))).toBe(false);
    expect(fs.existsSync(path.join(root, '.texeris', 'asset-trash', asset.path))).toBe(false);
  });
});
