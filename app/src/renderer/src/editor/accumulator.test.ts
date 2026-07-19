import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TextSplice } from '../../../shared/domain-types';
import { ChangeAccumulator } from './accumulator';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function collect(idleMs = 40) {
  const flushes: TextSplice[][] = [];
  const dirty = vi.fn();
  const acc = new ChangeAccumulator((s) => flushes.push(s), dirty, idleMs);
  return { acc, flushes, dirty };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ChangeAccumulator', () => {
  it('groups rapid typing into one flush with sequential splices', async () => {
    const { acc, flushes, dirty } = collect();
    acc.record('', 'a', 'typing');
    acc.record('a', 'ab', 'typing');
    acc.record('ab', 'abc', 'typing');
    await sleep(80);
    expect(flushes).toHaveLength(1);
    expect(flushes[0]).toHaveLength(3);
    expect(flushes[0][0]).toMatchObject({ from: 0, insertedText: 'a' });
    expect(flushes[0][2]).toMatchObject({ from: 2, insertedText: 'c' });
    expect(dirty).toHaveBeenCalledTimes(1);
    acc.dispose();
  });

  it('flushes pending changes when a paste arrives', () => {
    const { acc, flushes } = collect();
    acc.record('', 'typed', 'typing');
    acc.record('typed', 'typed pasted', 'paste');
    expect(flushes).toHaveLength(1); // typing group flushed before paste
    acc.flush();
    expect(flushes).toHaveLength(2);
    acc.dispose();
  });

  it('starts a new group after the idle gap', async () => {
    const { acc, flushes } = collect(40);
    acc.record('', 'one', 'typing');
    await sleep(80); // idle flush fires
    acc.record('one', 'one two', 'typing');
    await sleep(80);
    expect(flushes).toHaveLength(2);
    acc.dispose();
  });

  it('ignores no-op updates', () => {
    const { acc, flushes, dirty } = collect();
    acc.record('same', 'same', 'typing');
    expect(acc.hasPending).toBe(false);
    expect(flushes).toHaveLength(0);
    expect(dirty).not.toHaveBeenCalled();
    acc.dispose();
  });

  it('flushes the whole group across mixed edits', () => {
    const { acc, flushes } = collect();
    acc.record('hello world', 'hello brave world', 'typing');
    acc.record('hello brave world', 'hello brave new world', 'typing');
    acc.flush();
    expect(flushes).toHaveLength(1);
    expect(flushes[0][1]).toMatchObject({ deletedText: '', insertedText: 'new ' });
    acc.dispose();
  });
});
