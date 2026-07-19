import type { TextSplice } from './domain-types';

/**
 * Pure text-splice operations shared by main (validation, replay) and the
 * renderer editor adapter (deriving splices from editor states). No Node
 * dependencies — safe for both processes.
 */

/**
 * Apply splices sequentially, validating each against the text produced by
 * the previous ones. Throws on any mismatch and returns nothing partial —
 * callers must treat a throw as "no change happened".
 */
export function applySplices(text: string, splices: readonly TextSplice[]): string {
  let current = text;
  for (const splice of splices) {
    if (splice.from < 0 || splice.to < splice.from || splice.to > current.length) {
      throw new Error(
        `invalid splice range [${splice.from}, ${splice.to}) for text of length ${current.length}`,
      );
    }
    const actual = current.slice(splice.from, splice.to);
    if (actual !== splice.deletedText) {
      throw new Error(
        `splice validation failed at [${splice.from}, ${splice.to}): ` +
          `expected ${JSON.stringify(splice.deletedText)}, found ${JSON.stringify(actual)}`,
      );
    }
    current =
      current.slice(0, splice.from) + splice.insertedText + current.slice(splice.to);
  }
  return current;
}

/**
 * The smallest single splice turning `oldText` into `newText` (common
 * prefix/suffix trimmed). Used wherever only before/after text is known.
 */
export function minimalSplice(oldText: string, newText: string): TextSplice {
  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  const maxSuffix = maxPrefix - prefix;
  while (
    suffix < maxSuffix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    from: prefix,
    to: oldText.length - suffix,
    deletedText: oldText.slice(prefix, oldText.length - suffix),
    insertedText: newText.slice(prefix, newText.length - suffix),
  };
}

/** Short human summary of a change group, e.g. "+120 / −45 chars". */
export function summarizeSplices(splices: readonly TextSplice[]): string {
  let inserted = 0;
  let deleted = 0;
  for (const s of splices) {
    inserted += s.insertedText.length;
    deleted += s.deletedText.length;
  }
  return `+${inserted} / −${deleted} chars in ${splices.length} change(s)`;
}
