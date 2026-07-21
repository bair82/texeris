import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import { markdownIn, type PMNodeJSON } from '../../renderer/src/editor/lib/markdown-in';
import { markdownOut } from '../../renderer/src/editor/lib/markdown-out';
import { buildExtensions } from '../../renderer/src/editor/tiptap/nodes';

/**
 * Manual compatibility harness for representative Pandoc Markdown files.
 * CI skips it; run with TEXERIS_COMPAT_FIXTURE and TEXERIS_PANDOC_PATH to
 * validate a real private document without committing that document.
 */
const fixture = process.env.TEXERIS_COMPAT_FIXTURE;
const pandoc = process.env.TEXERIS_PANDOC_PATH;

describe.skipIf(!fixture || !pandoc)('Pandoc compatibility fixture', () => {
  it('converts into a schema-valid, stable canonical document', () => {
    const gfm = execFileSync(
      pandoc!,
      [fixture!, '--from=markdown', '--to=gfm', '--wrap=none', '--sandbox'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    const doc = markdownIn(gfm);
    const schema = getSchema(buildExtensions());
    schema.nodeFromJSON(doc).check();
    const canonical = markdownOut(doc);
    expect(markdownOut(markdownIn(canonical))).toBe(canonical);
    expect(canonical).not.toContain('<!-- -->');
    expect(canonical).not.toContain('&lt;table');
    const nodes = JSON.stringify(doc as PMNodeJSON);
    expect(nodes).toContain('"type":"table"');
    expect(nodes).toContain('"type":"underline"');
    expect(fs.readFileSync(fixture!, 'utf8').length).toBeGreaterThan(0);
  });
});
