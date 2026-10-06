import { describe, expect, it, vi } from 'vitest';

import { createManualTimers } from '../src/index.js';

describe('createManualTimers', () => {
  it('fires timers in due order only when advanced', () => {
    const timers = createManualTimers();
    const fired: string[] = [];
    timers.setTimeout(() => fired.push('late'), 200);
    timers.setTimeout(() => fired.push('early'), 100);
    const cleared = vi.fn();
    timers.clearTimeout(timers.setTimeout(cleared, 50));

    timers.advance(99);
    expect(fired).toEqual([]);
    timers.advance(101);
    expect(fired).toEqual(['early', 'late']);
    expect(cleared).not.toHaveBeenCalled();
    expect(timers.pending).toBe(0);
  });
});
