import { fixtureInstant, fixtureTime } from '../src/dateFixtures.js';

import { describe, expect, it } from 'vitest';

import { createFakeClock } from '../src/index.js';

describe('createFakeClock (CK-5)', () => {
  it('stands still until the test moves it', () => {
    const clock = createFakeClock(fixtureTime(-7, 1, 12, 0, 0, 0));

    expect(clock.now()).toEqual(new Date(fixtureTime(-7, 1, 12, 0, 0, 0)));
    expect(clock.now()).toEqual(new Date(fixtureTime(-7, 1, 12, 0, 0, 0)));
    clock.advance(1_500);
    expect(clock.now()).toEqual(new Date(fixtureTime(-7, 1, 12, 0, 1, 500)));
    clock.set(fixtureTime(3, 1, 0, 0, 0, 0));
    expect(clock.now()).toEqual(new Date(fixtureTime(3, 1, 0, 0, 0, 0)));
  });

  it('hands out a new Date each time, so a caller can\'t move it', () => {
    const clock = createFakeClock();
    clock.now().setFullYear(2000);

    expect(clock.now()).toEqual(new Date(fixtureInstant));
  });
});
