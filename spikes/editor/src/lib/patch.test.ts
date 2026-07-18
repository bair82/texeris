import { describe, expect, it } from 'vitest';
import mainSample from '../samples/main-sample.md?raw';
import { applyPatch, validatePatch, type DocumentPatch } from './patch';
import {
  patchAddQualifier,
  patchPolish,
  patchTightenSentence,
  patchTrimHedge,
} from '../patches/samples';

describe('patch validation', () => {
  it('accepts the correct base revision', () => {
    expect(validatePatch(mainSample, patchTrimHedge, 'r0').ok).toBe(true);
  });

  it('rejects a wrong base revision', () => {
    const result = validatePatch(mainSample, patchTrimHedge, 'r7');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].reason).toBe('base-revision-mismatch');
    }
  });

  it('rejects unknown group ids', () => {
    const result = validatePatch(mainSample, patchPolish, 'r0', ['nope']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.reason === 'unknown-group')).toBe(true);
  });
});

describe('patch application', () => {
  it('applies the hedge trim and produces the expected text', () => {
    const result = applyPatch(mainSample, patchTrimHedge);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).not.toContain('It is important to note that');
    expect(result.text).toContain('readers did not merely consume texts');
    expect(result.text.length).toBe(mainSample.length - 'It is important to note that '.length);
  });

  it('applies the sentence rewrite and the qualifier insertion', () => {
    const tightened = applyPatch(mainSample, patchTightenSentence);
    expect(tightened.ok).toBe(true);
    if (tightened.ok) {
      expect(tightened.text).toContain('Because printed books were expensive');
      expect(tightened.text).not.toContain('Due to the fact that');
    }
    const qualified = applyPatch(mainSample, patchAddQualifier);
    expect(qualified.ok).toBe(true);
    if (qualified.ok) {
      expect(qualified.text).toContain(
        'not a solitary one. This pattern, however, varies sharply by period, region, and genre. Circulating',
      );
    }
  });

  it('fails safely when expectedText does not match — text untouched', () => {
    const modified = mainSample.replace(
      'It is important to note that',
      'It is worth observing that',
    );
    const result = applyPatch(modified, patchTrimHedge);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.text).toBe(modified);
    expect(result.conflicts[0].reason).toBe('expected-text-mismatch');
  });

  it('supports partial group acceptance', () => {
    const result = applyPatch(mainSample, patchPolish, ['wording', 'trim-paren']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appliedGroups).toEqual(['wording', 'trim-paren']);
    expect(result.text).toContain('well-thumbed copy of Plutarch');
    expect(result.text).not.toContain('(often in pencil)');
    // Untouched group:
    expect(result.text).toContain('quiet reader in Leiden');
  });

  it('applies the full multi-group patch to all three spots', () => {
    const result = applyPatch(mainSample, patchPolish);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain('well-thumbed copy of Plutarch');
    expect(result.text).toContain('reticent reader in Leiden');
    expect(result.text).not.toContain('(often in pencil)');
  });

  it('detects overlapping changes', () => {
    const overlapping: DocumentPatch = {
      id: 'x',
      documentId: 'doc',
      baseRevisionId: 'r0',
      title: 'overlap',
      groups: [
        {
          id: 'g1',
          changes: [
            { from: 0, to: 5, expectedText: 'hello', insert: 'hi' },
            { from: 3, to: 8, expectedText: 'lo wo', insert: 'x' },
          ],
        },
      ],
    };
    const result = applyPatch('hello world', overlapping);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflicts.some((c) => c.reason === 'overlapping-changes')).toBe(true);
    }
  });
});
