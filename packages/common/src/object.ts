export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Freezes a value and everything reachable from it. Safe on shared and cyclic references. */
export const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (typeof value !== 'object' || value === null || seen.has(value))
    return value;

  seen.add(value);
  for (const nested of Object.values(value))
    deepFreeze(nested, seen);

  return Object.freeze(value);
};
