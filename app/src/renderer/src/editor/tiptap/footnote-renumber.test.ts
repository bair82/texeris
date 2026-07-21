import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { markdownIn, type PMNodeJSON } from '../lib/markdown-in';
import { markdownOut } from '../lib/markdown-out';
import { buildExtensions } from './nodes';
import { footnoteRenumberTransaction } from './footnote-renumber';

const schema = getSchema(buildExtensions());

function renumber(markdown: string): string {
  const doc = schema.nodeFromJSON(markdownIn(markdown)) as PMNode;
  const state = EditorState.create({ schema, doc });
  const tr = footnoteRenumberTransaction(state);
  return markdownOut(((tr ?? state.tr).doc).toJSON() as PMNodeJSON);
}

describe('footnote renumber + reorder (EU6 footnote management)', () => {
  it('renumbers refs to document order, retargets defs, and re-sorts defs', () => {
    // a footnote inserted BEFORE an existing one (transient unique labels)
    const out = renumber('A[^2] B[^1]\n\n[^1]: second\n\n[^2]: first\n');
    expect(out.indexOf('[^1]')).toBeLessThan(out.indexOf('[^2]'));
    expect(out).toContain('[^1]: first');
    expect(out).toContain('[^2]: second');
    // defs are physically ordered to match the refs
    expect(out.indexOf('[^1]: first')).toBeLessThan(out.indexOf('[^2]: second'));
  });

  it('reorders defs even when ref labels are already consistent', () => {
    const out = renumber('A[^1] B[^2]\n\n[^2]: second\n\n[^1]: first\n');
    expect(out.indexOf('[^1]: first')).toBeLessThan(out.indexOf('[^2]: second'));
  });

  it('heals numbering after a ref is deleted and keeps the orphaned def', () => {
    const out = renumber('A B[^2]\n\n[^1]: orphan\n\n[^2]: kept\n');
    expect(out).toContain('B[^1]');
    expect(out).toContain('[^1]: kept');
    expect(out).toContain('[^2]: orphan');
    expect(out.indexOf('[^1]: kept')).toBeLessThan(out.indexOf('[^2]: orphan'));
  });

  it('is a no-op when numbering and order are already consistent', () => {
    // consecutive defs serialize without blank lines between them
    const markdown = 'A[^1] B[^2]\n\n[^1]: x\n[^2]: y\n';
    expect(renumber(markdown)).toBe(markdown);
  });

  it('leaves defs untouched when no refs remain (cut/paste safe)', () => {
    const markdown = 'A B\n\n[^2]: y\n[^1]: x\n';
    expect(renumber(markdown)).toBe(markdown);
  });

  it('keeps multi-paragraph def content through a move', () => {
    const out = renumber('A[^1] B[^2]\n\n[^2]: para one\n\n  para two\n\n[^1]: x\n');
    expect(out).toContain('para one');
    expect(out).toContain('para two');
    expect(out.indexOf('para one')).toBeLessThan(out.indexOf('para two'));
  });
});
