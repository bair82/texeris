import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import mainSample from '../samples/main-sample.md?raw';
import edgeSample from '../samples/edge-sample.md?raw';
import { markdownIn, type PMNodeJSON } from './markdown-in';
import { markdownOut } from './markdown-out';
import { buildExtensions } from '../tiptap/nodes';

describe('round-trip identity', () => {
  it.each([
    ['main-sample', mainSample],
    ['edge-sample', edgeSample],
  ])('markdownOut(markdownIn(%s)) is byte-identical', (_name, text) => {
    expect(markdownOut(markdownIn(text))).toBe(text);
  });

  it.each([
    ['main-sample', mainSample],
    ['edge-sample', edgeSample],
  ])('survives validation against the real Tiptap schema (%s)', (_name, text) => {
    const schema = getSchema(buildExtensions());
    const doc = schema.nodeFromJSON(markdownIn(text));
    doc.check(); // throws if any content violates the schema
    expect(markdownOut(doc.toJSON() as PMNodeJSON)).toBe(text);
  });
});
