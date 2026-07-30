import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  citationStyleSettings,
  importCustomCitationStyle,
  resolveCitationStylePath,
  setCitationStyle,
} from './citationStyles';
import { createProject, openProject, type ProjectContext } from './project';

let root: string;
let ctx: ProjectContext;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-csl-'));
  ctx = createProject(root);
});

afterEach(() => {
  ctx.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('project citation styles', () => {
  it('defaults to Chicago author-date and remembers a built-in choice', () => {
    expect(citationStyleSettings(ctx)).toMatchObject({
      id: 'chicago-author-date',
      label: 'Chicago author-date',
      customAvailable: false,
    });
    setCitationStyle(ctx, 'apa');
    expect(citationStyleSettings(ctx).id).toBe('apa');
    expect(
      JSON.parse(fs.readFileSync(path.join(root, '.texeris', 'project.json'), 'utf8')),
    ).toMatchObject({ citationStyle: 'apa' });

    ctx.db.close();
    ctx = openProject(root);
    expect(citationStyleSettings(ctx).id).toBe('apa');
  });

  it('copies and remembers a valid custom CSL style', () => {
    const source = path.join(root, 'journal.csl');
    fs.writeFileSync(
      source,
      `<?xml version="1.0"?>
<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0">
  <info><title>Journal House Style</title><id>https://example.test/style</id></info>
  <citation><layout><text variable="title"/></layout></citation>
  <bibliography><layout><text variable="title"/></layout></bibliography>
</style>
`,
    );
    expect(importCustomCitationStyle(ctx, source)).toMatchObject({
      id: 'custom',
      label: 'Journal House Style',
      customAvailable: true,
      customLabel: 'Journal House Style',
    });
    const copied = path.join(root, '.texeris', 'citation-style.csl');
    expect(fs.readFileSync(copied, 'utf8')).toContain('Journal House Style');
    expect(resolveCitationStylePath(ctx, '/unused', 'custom')).toBe(copied);
  });

  it('rejects malformed custom files and a missing custom selection', () => {
    const source = path.join(root, 'not-a-style.csl');
    fs.writeFileSync(source, '<xml>no style here</xml>');
    expect(() => importCustomCitationStyle(ctx, source)).toThrow(/not a complete CSL style/);
    expect(() => setCitationStyle(ctx, 'custom')).toThrow(/Choose a custom CSL file/);

    fs.writeFileSync(
      source,
      '<style xmlns="http://purl.org/net/xbiblio/csl"><info><title>Dependent</title></info></style>',
    );
    expect(() => importCustomCitationStyle(ctx, source)).toThrow(/independent CSL style/);
  });

  it('resolves only known bundled files', () => {
    const resources = path.join(root, 'resources');
    fs.mkdirSync(resources);
    fs.writeFileSync(path.join(resources, 'ieee.csl'), '<style/>');
    expect(resolveCitationStylePath(ctx, resources, 'ieee')).toBe(
      path.join(resources, 'ieee.csl'),
    );
    expect(() => resolveCitationStylePath(ctx, resources, 'apa')).toThrow(/Reinstall Texeris/);
  });
});
