import { randomUUID } from 'node:crypto';

/** Time source. Domain code takes a Clock instead of calling `Date.now()`, so tests can drive time. */
export interface Clock {
  now(): Date;
}

/** ID source. Domain code takes an IdGenerator instead of making random IDs, so tests get stable IDs. */
export interface IdGenerator {
  next(): string;
}

/** Timer source for deadlines. Injected where a test must fire a deadline without waiting for it. */
export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export const systemTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
};

export const randomIdGenerator: IdGenerator = {
  next: () => randomUUID(),
};
