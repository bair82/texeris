import { describe, expect, it } from 'vitest';
import { resolveAnchors, type PatchGroupInput } from './patch-types';

const TEXT = 'the quick brown fox jumps over the lazy fox';

function group(changes: PatchGroupInput['changes']): PatchGroupInput[] {
  return [{ explanation: 'test', changes }];
}

describe('resolveAnchors', () => {
  it('passes explicit offsets through', () => {
    const result = resolveAnchors(TEXT, group([{ from: 4, to: 9, expectedText: 'quick', insert: 'slow' }]));
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.groups[0].changes[0]).toMatchObject({ from: 4, to: 9 });
    }
  });

  it('resolves a unique anchor', () => {
    const result = resolveAnchors(TEXT, group([{ expectedText: 'quick', insert: 'slow' }]));
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.groups[0].changes[0]).toMatchObject({ from: 4, to: 9 });
    }
  });

  it('reports anchor-not-found', () => {
    const result = resolveAnchors(TEXT, group([{ expectedText: 'elephant', insert: 'x' }]));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.conflicts[0].reason).toBe('anchor-not-found');
    }
  });

  it('reports anchor-ambiguous and resolves with context', () => {
    const ambiguous = resolveAnchors(TEXT, group([{ expectedText: 'fox', insert: 'wolf' }]));
    expect(ambiguous).toMatchObject({ ok: false });
    if (!ambiguous.ok) {
      expect(ambiguous.conflicts[0].reason).toBe('anchor-ambiguous');
      expect(ambiguous.conflicts[0].message).toContain('2 places');
    }

    const withContext = resolveAnchors(
      TEXT,
      group([{ expectedText: 'fox', insert: 'wolf', prefixContext: 'the lazy ' }]),
    );
    expect(withContext).toMatchObject({ ok: true });
    if (withContext.ok) {
      const change = withContext.groups[0].changes[0];
      expect(TEXT.slice(change.from, change.to)).toBe('fox');
      expect(change.from).toBe(TEXT.lastIndexOf('fox'));
    }
  });

  it('resolves pure insertions via a context anchor or fails with anchor-missing', () => {
    const viaPrefix = resolveAnchors(
      TEXT,
      group([{ expectedText: '', insert: ' very', prefixContext: 'the quick' }]),
    );
    expect(viaPrefix).toMatchObject({ ok: true });
    if (viaPrefix.ok) {
      const at = TEXT.indexOf('quick') + 'quick'.length;
      expect(viaPrefix.groups[0].changes[0]).toMatchObject({ from: at, to: at });
    }

    const missing = resolveAnchors(TEXT, group([{ expectedText: '', insert: ' very' }]));
    expect(missing).toMatchObject({ ok: false });
    if (!missing.ok) {
      expect(missing.conflicts[0].reason).toBe('anchor-missing');
    }
  });
});
