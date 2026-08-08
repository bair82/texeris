import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assembleContext, buildSystemPrompt } from './context';
import { createProject, ensureDocument, type ProjectContext } from '../services/project';

let root: string;
let ctx: ProjectContext;

const MANUSCRIPT = '# Paper\n\n## Intro\n\nSome text here.\n\n## Body\n\nMore text.\n';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-ctx-'));
  ctx = createProject(root);
  const docId = ensureDocument(ctx, 'manuscript.md');
  ctx.revisions.commit(docId, [{ from: 0, to: 0, deletedText: '', insertedText: MANUSCRIPT }], {
    actor: 'user',
    source: { kind: 'typing' },
  });
});

afterEach(() => {
  ctx.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('assembleContext', () => {
  it('document scope includes the full text with revision in the manifest', () => {
    const { contextText, manifest } = assembleContext(ctx, { kind: 'document' });
    expect(contextText).toContain('Some text here.');
    expect(contextText).toContain('revision="1"');
    expect(manifest.baseRevision).toBe(1);
    expect(manifest.truncated).toBe(false);
    expect(manifest.items[0].chars).toBe(MANUSCRIPT.length);
  });

  it('truncates an over-budget document to the outline with a notice', () => {
    const { contextText, manifest } = assembleContext(ctx, { kind: 'document' }, 20);
    expect(manifest.truncated).toBe(true);
    expect(contextText).toContain('- Intro');
    expect(contextText).toContain('read_document_range');
    expect(contextText).not.toContain('Some text here.');
    expect(manifest.notices.length).toBeGreaterThan(0);
  });

  it('section scope slices one section', () => {
    const { contextText, manifest } = assembleContext(ctx, {
      kind: 'section',
      heading: 'Intro',
    });
    expect(contextText).toContain('Some text here.');
    expect(contextText).not.toContain('More text.');
    expect(manifest.truncated).toBe(false);
  });

  it('missing section falls back to the outline with a notice', () => {
    const { contextText, manifest } = assembleContext(ctx, {
      kind: 'section',
      heading: 'Nope',
    });
    expect(manifest.notices[0]).toMatch(/not found/);
    expect(contextText).toContain('- Body');
  });

  it('selection scope slices the char range (WP2 seam)', () => {
    const { contextText, manifest } = assembleContext(ctx, {
      kind: 'selection',
      from: 0,
      to: 7,
    });
    expect(contextText).toContain('# Paper');
    expect(contextText).not.toContain('Some text');
    expect(manifest.items[0].chars).toBe(7);
  });

  it('uses the explicitly active document rather than the project main document', () => {
    const welcomeId = ensureDocument(ctx, 'welcome.md');
    ctx.revisions.commit(welcomeId, [{ from: 0, to: 0, deletedText: '', insertedText: '# Welcome\n' }], {
      actor: 'user',
      source: { kind: 'typing' },
    });
    const { contextText, manifest } = assembleContext(ctx, {
      kind: 'document',
      documentId: welcomeId,
    });
    expect(contextText).toContain('<document source="welcome.md"');
    expect(contextText).toContain('# Welcome');
    expect(contextText).not.toContain('Some text here.');
    expect(manifest.documentId).toBe(welcomeId);
  });

  it('includes project instructions when present', () => {
    fs.writeFileSync(path.join(root, 'project-instructions.md'), 'Write plainly.');
    const { contextText, manifest } = assembleContext(ctx, { kind: 'document' });
    expect(contextText).toContain('<project-instructions>');
    expect(contextText).toContain('Write plainly.');
    expect(manifest.items.map((i) => i.label)).toContain('project-instructions.md');
  });

  it('includes explicitly attached archive passages and records their IDs', () => {
    const { contextText, manifest } = assembleContext(
      ctx,
      { kind: 'document' },
      undefined,
      [{
        passageId: 'passage-1',
        sourceId: 'source-1',
        title: 'Earlier Paper',
        heading: 'Discussion',
        page: 7,
        excerpt: 'A characteristic sentence from the author’s earlier work.',
        startOffset: 320,
      }],
    );

    expect(contextText).toContain('<writing-archive>');
    expect(contextText).toContain('title="Earlier Paper"');
    expect(contextText).toContain('section="Discussion"');
    expect(contextText).toContain('A characteristic sentence');
    expect(manifest.archivePassageIds).toEqual(['passage-1']);
    expect(manifest.items.at(-1)).toMatchObject({
      label: 'Earlier Paper § Discussion · p. 7 (archive)',
    });
  });
});

describe('buildSystemPrompt', () => {
  it('embeds the assembled context', () => {
    const assembled = assembleContext(ctx, { kind: 'document' });
    const prompt = buildSystemPrompt(assembled);
    expect(prompt).toContain('Texeris');
    expect(prompt).toContain(assembled.contextText);
  });
});
