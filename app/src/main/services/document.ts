import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Atomic file write (plan §4.10): write to a tmp file in the same directory,
 * fsync, rename over the target. Tmp files are recognisable and are never
 * treated as content — see cleanOrphanTmpFiles.
 */
const TMP_MARK = '.texeris-tmp-';
let tmpCounter = 0;

export function atomicWriteText(filePath: string, text: string): void {
  const tmpPath = `${filePath}${TMP_MARK}${process.pid}-${tmpCounter++}`;
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
  // Best-effort directory fsync so the rename itself is durable.
  try {
    const dirFd = fs.openSync(path.dirname(filePath), 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // some filesystems can't fsync directories; the rename already landed
  }
}

/**
 * Remove leftover tmp files from interrupted atomic writes in a directory.
 * Never reads them into content — they are cleaned, never silently chosen.
 */
export function cleanOrphanTmpFiles(dir: string): string[] {
  const removed: string[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (entry.includes(TMP_MARK)) {
      fs.rmSync(path.join(dir, entry), { force: true });
      removed.push(entry);
    }
  }
  return removed;
}
