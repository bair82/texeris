#!/usr/bin/env node
// Downloads the exact converter shipped in a release build. This is invoked
// deliberately by dist scripts, never by install or normal development.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const version = '3.10';
const architecture = process.arch === 'x64' ? 'amd64' : process.arch;
const target = `${process.platform}-${architecture}`;
const assets = {
  'linux-amd64': {
    file: `pandoc-${version}-linux-amd64.tar.gz`,
    sha256: 'e0f8af62d0f267d22baa5bcefe6d5dda3a097ccc60de794b759fe03159923244',
    archive: 'tar',
    directory: `pandoc-${version}`,
  },
  'linux-arm64': {
    file: `pandoc-${version}-linux-arm64.tar.gz`,
    sha256: '55413dfb0c1aec861641fe858f1f73e84848f3db497b1c0c02e62887ea76f4a4',
    archive: 'tar',
    directory: `pandoc-${version}`,
  },
  'darwin-amd64': {
    file: `pandoc-${version}-x86_64-macOS.zip`,
    sha256: '6334f4d9af7c9e37e761dfad56fa5507685f6d29724ebf31c4be6d5c654a3161',
    archive: 'zip',
    directory: `pandoc-${version}-x86_64`,
  },
  'darwin-arm64': {
    file: `pandoc-${version}-arm64-macOS.zip`,
    sha256: 'd9cad01d96ae774a0dc8c8c45bb1ad3e4c5ff2cc2e24f45958f5f9b7974aee34',
    archive: 'zip',
    directory: `pandoc-${version}-arm64`,
  },
};

if (!(target in assets)) {
  throw new Error(`Bundled Pandoc preparation is not supported for ${target}.`);
}

const asset = assets[target];
const destination = join('vendor', 'resources', 'pandoc', target, 'pandoc');
if (existsSync(destination)) {
  console.log(`Pandoc ${version} already prepared for ${target}.`);
  process.exit(0);
}

const temporary = join(tmpdir(), asset.file);
const url = `https://github.com/jgm/pandoc/releases/download/${version}/${asset.file}`;
console.log(`Downloading Pandoc ${version} for ${target}…`);
execFileSync('curl', ['--fail', '--location', '--retry', '3', '--output', temporary, url], { stdio: 'inherit' });
const actual = createHash('sha256').update(readFileSync(temporary)).digest('hex');
if (actual !== asset.sha256) throw new Error(`Pandoc checksum mismatch for ${asset.file}`);

const extracted = join(tmpdir(), `texeris-pandoc-${process.pid}`);
rmSync(extracted, { recursive: true, force: true });
mkdirSync(extracted, { recursive: true });
if (asset.archive === 'tar') {
  execFileSync('tar', ['-xzf', temporary, '-C', extracted], { stdio: 'inherit' });
} else {
  execFileSync('unzip', ['-q', temporary, '-d', extracted], { stdio: 'inherit' });
}
const binary = join(extracted, asset.directory, 'bin', 'pandoc');
if (!existsSync(binary)) throw new Error(`Pandoc archive did not contain ${binary}`);
mkdirSync(dirname(destination), { recursive: true });
// /tmp may be a separate filesystem from the repository worktree.
copyFileSync(binary, destination);
execFileSync('chmod', ['755', destination]);
rmSync(extracted, { recursive: true, force: true });
console.log(`Prepared ${basename(destination)} for packaging.`);
