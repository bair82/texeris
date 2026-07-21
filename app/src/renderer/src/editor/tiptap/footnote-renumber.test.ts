import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { markdownIn, type PMNodeJSON } from '../lib/markdown-in';
import { markdownOut } from '../lib/markdown-out';
import { buildExtensions } from './nodes';
import { planFootnoteRenumber } from './footnote-renumber';

const schema = getSchema(buildExtensions());

function renumber(markdown: string): string {
  const doc = schema.nodeFromJSON(markdownIn(markdown)) as PMNode;
  const state = EditorState.create({ schema, doc });
  const edits = planFootnoteRenumber(state.doc);
  const tr = state.tr;
  for (const edit of edits) {
    tr.setNodeAttribute(edit.pos, 'label', edit.label);
  }
  return markdownOut(tr.doc.toJSON() as PMNodeJSON);
}

describe('planFootnoteRenumber (EU6 footnote management)', () => {
  it('renumbers refs to document order and retargets defs', () => {
    // a footnote inserted BEFORE an existing one (transient unique labels)
    const out = renumber('A[^2] B[^1]\n\n[^2]: first\n[^1]: second\n');
    expect(out.indexOf('[^1]')).toBeLessThan(out.indexOf('[^2]'));
    expect(out).toContain('[^1]: first');
    expect(out).toContain('[^2]: second');
  });

  it('heals numbering after a ref is deleted and keeps the orphaned def', () => {
    const out = renumber('A B[^2]\n\n[^1]: orphan\n[^2]: kept\n');
    expect(out).toContain('B[^1]');
    expect(out).toContain('[^1]: kept');
    expect(out).toContain('[^2]: orphan');
  });

  it('is a no-op when numbering is already consistent', () => {
    const markdown = 'A[^1] B[^2]\n\n[^1]: x\n[^2]: y\n';
    expect(renumber(markdown)).toBe(markdown);
  });

  it('leaves defs untouched when no refs remain (cut/paste safe)', () => {
    const markdown = 'A B\n\n[^1]: x\n[^2]: y\n';
    expect(renumber(markdown)).toBe(markdown);
  });
});
