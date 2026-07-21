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
const linuxAssets = {
  'linux-amd64': {
    file: `pandoc-${version}-linux-amd64.tar.gz`,
    sha256: 'e0f8af62d0f267d22baa5bcefe6d5dda3a097ccc60de794b759fe03159923244',
  },
  'linux-arm64': {
    file: `pandoc-${version}-linux-arm64.tar.gz`,
    sha256: '55413dfb0c1aec861641fe858f1f73e84848f3db497b1c0c02e62887ea76f4a4',
  },
};

if (!(target in linuxAssets)) {
  throw new Error(`Bundled Pandoc preparation is currently supported for Linux amd64/arm64, not ${target}.`);
}

const asset = linuxAssets[target];
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
execFileSync('tar', ['-xzf', temporary, '-C', extracted], { stdio: 'inherit' });
const binary = join(extracted, `pandoc-${version}`, 'bin', 'pandoc');
if (!existsSync(binary)) throw new Error(`Pandoc archive did not contain ${binary}`);
mkdirSync(dirname(destination), { recursive: true });
// /tmp may be a separate filesystem from the repository worktree.
copyFileSync(binary, destination);
execFileSync('chmod', ['755', destination]);
rmSync(extracted, { recursive: true, force: true });
console.log(`Prepared ${basename(destination)} for packaging.`);
