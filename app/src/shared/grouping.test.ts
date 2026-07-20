import { describe, expect, it } from 'vitest';
import { JUMP_CHARS, RevisionGrouper } from './grouping';

describe('RevisionGrouper (plan §8 rules)', () => {
  it('starts a new group on the first signal', () => {
    const g = new RevisionGrouper();
    expect(g.shouldStartNewGroup({ kind: 'typing', at: 0, from: 0 })).toBe(true);
  });

  it('continues the group for typing within the idle window at nearby offsets', () => {
    const g = new RevisionGrouper(1000);
    g.shouldStartNewGroup({ kind: 'typing', at: 0, from: 30 });
    expect(g.shouldStartNewGroup({ kind: 'typing', at: 500, from: 31 })).toBe(false);
    expect(g.shouldStartNewGroup({ kind: 'typing', at: 999, from: 32 })).toBe(false);
  });

  it('keeps paragraph breaks at the document end in one group', () => {
    // each Enter shifts line numbering by up to two — offsets stay sequential
    const g = new RevisionGrouper(1000);
    g.shouldStartNewGroup({ kind: 'typing', at: 0, from: 100 });
    expect(g.shouldStartNewGroup({ kind: 'typing', at: 100, from: 101 })).toBe(false);
    expect(g.shouldStartNewGroup({ kind: 'typing', at: 200, from: 103 })).toBe(false);
    expect(g.shouldStartNewGroup({ kind: 'typing', at: 300, from: 104 })).toBe(false);
  });

  it('starts a new group after the idle gap', () => {
    const g = new RevisionGrouper(1000);
    g.shouldStartNewGroup({ kind: 'typing', at: 0, from: 0 });
    expect(g.shouldStartNewGroup({ kind: 'typing', at: 1001, from: 0 })).toBe(true);
  });

  it('starts a new group on a caret jump between consecutive changes', () => {
    const g = new RevisionGrouper();
    g.shouldStartNewGroup({ kind: 'typing', at: 0, from: 100 });
    expect(
      g.shouldStartNewGroup({ kind: 'typing', at: 10, from: 100 + JUMP_CHARS + 1 }),
    ).toBe(true);
    expect(g.shouldStartNewGroup({ kind: 'typing', at: 20, from: 100 + JUMP_CHARS })).toBe(
      false,
    );
  });

  it('starts a new group on a backward caret jump (erase far away)', () => {
    const g = new RevisionGrouper();
    g.shouldStartNewGroup({ kind: 'typing', at: 0, from: 500 });
    expect(g.shouldStartNewGroup({ kind: 'typing', at: 10, from: 120 })).toBe(true);
  });

  it('always starts a new group on paste and on patch application', () => {
    const g = new RevisionGrouper();
    g.shouldStartNewGroup({ kind: 'typing', at: 0, from: 0 });
    expect(g.shouldStartNewGroup({ kind: 'paste', at: 10, from: 0 })).toBe(true);
    expect(g.shouldStartNewGroup({ kind: 'patch', at: 20, from: 0 })).toBe(true);
  });

  it('starts fresh after reset (group committed)', () => {
    const g = new RevisionGrouper();
    g.shouldStartNewGroup({ kind: 'typing', at: 0, from: 0 });
    g.reset();
    expect(g.shouldStartNewGroup({ kind: 'typing', at: 10, from: 0 })).toBe(true);
  });
});
