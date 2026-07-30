import * as fs from 'node:fs';
import * as path from 'node:path';

/** Resolve a canonical Markdown document while confining it to its project. */
export function resolveProjectDocumentPath(
  root: string,
  relativePath: string,
): string {
  if (
    !relativePath ||
    relativePath.includes('\0') ||
    path.isAbsolute(relativePath) ||
    /^[A-Za-z]:[\\/]/.test(relativePath)
  ) {
    throw new Error(`invalid project document path ${JSON.stringify(relativePath)}`);
  }
  const portable = relativePath.replaceAll('\\', '/');
  const segments = portable.split('/');
  if (
    !portable.toLowerCase().endsWith('.md') ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`invalid project document path ${JSON.stringify(relativePath)}`);
  }

  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, ...segments);
  if (!target.startsWith(`${rootResolved}${path.sep}`)) {
    throw new Error(`project document path escapes the project: ${relativePath}`);
  }

  // Existing symlinks must not turn a lexically safe path into an external
  // read/write. For a new nested file, validate its nearest existing parent.
  let existing = target;
  while (!fs.existsSync(existing) && existing !== rootResolved) {
    existing = path.dirname(existing);
  }
  const rootReal = fs.realpathSync(rootResolved);
  const existingReal = fs.realpathSync(existing);
  if (
    existingReal !== rootReal &&
    !existingReal.startsWith(`${rootReal}${path.sep}`)
  ) {
    throw new Error(`project document path escapes through a symlink: ${relativePath}`);
  }
  return target;
}
