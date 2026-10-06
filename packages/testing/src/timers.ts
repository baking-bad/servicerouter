import type { Timers } from '@servicerouter/common';

export interface ManualTimers extends Timers {
  // Timers scheduled and not yet fired or cleared
  readonly pending: number;
  /** Moves virtual time forward and fires every timer that comes due. */
  advance(ms: number): void;
}

/** Timers that fire only when a test advances them. No real waiting. */
export const createManualTimers = (): ManualTimers => {
  let now = 0;
  let nextId = 0;
  const scheduled = new Map<number, { readonly due: number; readonly callback: () => void }>();

  return {
    get pending() {
      return scheduled.size;
    },
    setTimeout: (callback, ms) => {
      nextId += 1;
      scheduled.set(nextId, { due: now + ms, callback });

      return nextId;
    },
    clearTimeout: handle => {
      scheduled.delete(handle as number);
    },
    advance: ms => {
      now += ms;
      const due = [...scheduled.entries()].filter(([, timer]) => timer.due <= now).sort(([, a], [, b]) => a.due - b.due);
      for (const [id, timer] of due) {
        scheduled.delete(id);
        timer.callback();
      }
    },
  };
};
