import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadWorkspaceConfig, DEFAULT_CONFIG } from './settings';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-settings-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadWorkspaceConfig', () => {
  it('creates config.json with defaults on first run', () => {
    const config = loadWorkspaceConfig(dir);
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(true);
  });

  it('loads a customized file', () => {
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ modes: { fast: { provider: 'x', model: 'y' } } }),
    );
    const config = loadWorkspaceConfig(dir);
    expect(config.modes.fast).toEqual({ provider: 'x', model: 'y' });
    // missing mode falls back to defaults
    expect(config.modes.deep).toEqual(DEFAULT_CONFIG.modes.deep);
  });
});
