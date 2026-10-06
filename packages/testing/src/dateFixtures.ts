/** The fixed reference instant for deterministic test data. */
export const fixtureInstant = '2026-10-06T19:50:00+08:00';

/** A UTC calendar boundary relative to the reference month. */
export const fixtureTime = (months = 0, day = 6, hours = 11, minutes = 50, seconds = 0, milliseconds = 0): string => {
  const reference = new Date(fixtureInstant);
  return new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() + months, day, hours, minutes, seconds, milliseconds)).toISOString();
};

export const fixtureDay = (months = 0, day = 6): string => fixtureTime(months, day).slice(0, 10);
export const fixtureRun = (months = 0, day = 6): string => `run_${fixtureDay(months, day)}`;
