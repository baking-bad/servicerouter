import type { Clock, MicroUsd } from '@servicerouter/common';
import { RedisNotReadyError, type Redis } from '@servicerouter/db';

// The Signer's key space after the connection's prefix (README section 5: `spend:*`). Only its Redis
// ACL user may write it, so the proxy can't reset it (SG-5).
export const spendKeyPrefix = 'spend:';

export type SpendRefusal = 'hourly_limit' | 'daily_limit';

/** Port: the spend limits per network (SG-4). */
export interface SpendLimits {
  /** Checks both limits and adds the amount, atomically. Returns why it refused, or undefined. */
  reserve(input: { readonly network: string; readonly amount: MicroUsd }): Promise<SpendRefusal | undefined>;
}

// Check both windows, then add to both, in one script: two Signers never pass a limit together
const reserveScript = `
local hour = tonumber(redis.call('GET', KEYS[1]) or '0')
local day = tonumber(redis.call('GET', KEYS[2]) or '0')
local amount = tonumber(ARGV[1])
local hourLimit = tonumber(ARGV[2])
local dayLimit = tonumber(ARGV[3])
if hourLimit >= 0 and hour + amount > hourLimit then return 1 end
if day + amount > dayLimit then return 2 end
redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], 7200)
redis.call('INCRBY', KEYS[2], ARGV[1])
redis.call('EXPIRE', KEYS[2], 172800)
return 0`;

/**
 * Spend limits per network in Redis (SG-4): per clock hour and per UTC day, in micro-USD. A hourly
 * limit is optional (AR8). Fails closed: while Redis is down, nothing is signed.
 */
export const createRedisSpendLimits = ({ redis, clock, hourly, daily }: {
  readonly redis: Redis;
  readonly clock: Clock;
  readonly hourly: MicroUsd | undefined;
  readonly daily: MicroUsd;
}): SpendLimits => ({
  reserve: async ({ network, amount }) => {
    if (!redis.client.isReady)
      throw new RedisNotReadyError();

    const now = clock.now().toISOString();
    const base = `${redis.prefix}${spendKeyPrefix}${network}`;
    const result = await redis.client.eval(reserveScript, {
      keys: [`${base}:hour:${now.slice(0, 13)}`, `${base}:day:${now.slice(0, 10)}`],
      arguments: [amount.toString(), hourly === undefined ? '-1' : hourly.toString(), daily.toString()],
    });

    return result === 1 ? 'hourly_limit' : result === 2 ? 'daily_limit' : undefined;
  },
});
