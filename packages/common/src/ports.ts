import { randomUUID } from 'node:crypto';

/** Time source. Domain code takes a Clock instead of calling `Date.now()`, so tests can drive time. */
export interface Clock {
  now(): Date;
}

/** ID source. Domain code takes an IdGenerator instead of making random IDs, so tests get stable IDs. */
export interface IdGenerator {
  next(): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export const randomIdGenerator: IdGenerator = {
  next: () => randomUUID(),
};
