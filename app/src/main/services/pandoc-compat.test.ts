import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import { markdownIn, type PMNodeJSON } from '../../renderer/src/editor/lib/markdown-in';
import { markdownOut } from '../../renderer/src/editor/lib/markdown-out';
import { buildExtensions } from '../../renderer/src/editor/tiptap/nodes';
import { createProject } from './project';
import { exportDocumentFile, importDocumentFile } from './documents';

/**
 * Manual compatibility harness for representative Pandoc Markdown files.
 * CI skips it; run with TEXERIS_COMPAT_FIXTURE and TEXERIS_PANDOC_PATH to
 * validate a real private document without committing that document.
 */
const fixture = process.env.TEXERIS_COMPAT_FIXTURE;
const pandoc = process.env.TEXERIS_PANDOC_PATH;

describe.skipIf(!fixture || !pandoc)('Pandoc compatibility fixture', () => {
  it.skipIf(path.extname(fixture ?? '').toLowerCase() !== '.md')('converts Markdown into a schema-valid, stable canonical document', () => {
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

  it.skipIf(path.extname(fixture ?? '').toLowerCase() !== '.docx')('imports media and exports a schema-valid document', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-pandoc-compat-'));
    const project = createProject(root);
    try {
      const imported = importDocumentFile(project, fixture!);
      const markdown = fs.readFileSync(path.join(root, imported.path), 'utf8');
      const doc = markdownIn(markdown);
      getSchema(buildExtensions()).nodeFromJSON(doc).check();
      expect(markdownOut(markdownIn(markdownOut(doc)))).toBe(markdownOut(doc));
      expect(markdown).toMatch(/assets\/[^/]+\/media\//);
      const assetFiles = fs.readdirSync(path.join(root, 'assets', path.basename(imported.path, '.md'), 'media'));
      expect(assetFiles.length).toBeGreaterThanOrEqual(1);
      const output = path.join(root, 'roundtrip.docx');
      exportDocumentFile(project, imported.id, output);
      expect(fs.statSync(output).size).toBeGreaterThan(10_000);
    } finally {
      project.db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
