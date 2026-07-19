import { describe, expect, it } from 'vitest';
import { RevisionGrouper } from './grouping';

describe('RevisionGrouper (plan §8 rules)', () => {
  it('starts a new group on the first signal', () => {
    const g = new RevisionGrouper();
    expect(g.shouldStartNewGroup({ kind: 'typing', at: 0, changedLine: 0 })).toBe(true);
  });

  it('continues the group for typing within the idle window on nearby lines', () => {
    const g = new RevisionGrouper(1000);
    g.shouldStartNewGroup({ kind: 'typing', at: 0, changedLine: 3 });
    expect(g.shouldStartNewGroup({ kind: 'typing', at: 500, changedLine: 3 })).toBe(false);
    expect(g.shouldStartNewGroup({ kind: 'typing', at: 999, changedLine: 4 })).toBe(false);
  });

  it('starts a new group after the idle gap', () => {
    const g = new RevisionGrouper(1000);
    g.shouldStartNewGroup({ kind: 'typing', at: 0, changedLine: 0 });
    expect(g.shouldStartNewGroup({ kind: 'typing', at: 1001, changedLine: 0 })).toBe(true);
  });

  it('starts a new group on a >1-line jump between consecutive changes', () => {
    const g = new RevisionGrouper();
    g.shouldStartNewGroup({ kind: 'typing', at: 0, changedLine: 10 });
    expect(g.shouldStartNewGroup({ kind: 'typing', at: 10, changedLine: 12 })).toBe(true);
    expect(g.shouldStartNewGroup({ kind: 'typing', at: 20, changedLine: 11 })).toBe(false);
  });

  it('always starts a new group on paste and on patch application', () => {
    const g = new RevisionGrouper();
    g.shouldStartNewGroup({ kind: 'typing', at: 0, changedLine: 0 });
    expect(g.shouldStartNewGroup({ kind: 'paste', at: 10, changedLine: 0 })).toBe(true);
    expect(g.shouldStartNewGroup({ kind: 'patch', at: 20, changedLine: 0 })).toBe(true);
  });

  it('starts fresh after reset (group committed)', () => {
    const g = new RevisionGrouper();
    g.shouldStartNewGroup({ kind: 'typing', at: 0, changedLine: 0 });
    g.reset();
    expect(g.shouldStartNewGroup({ kind: 'typing', at: 10, changedLine: 0 })).toBe(true);
  });
});
