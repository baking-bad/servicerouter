import { ServiceRouterError } from './errors.js';

/** Integer micro-USD: 1 USD = 1,000,000. Never a float. */
export type MicroUsd = bigint;

export const usdDecimals = 6;
// Postgres bigint, where balances and amounts are stored
export const maxMicroUsd: MicroUsd = 2n ** 63n - 1n;
export const maxAssetDecimals = 36;

// Plain decimal: no sign, no exponent, no leading zeros, at most 6 fractional digits
export const usdAmountPattern = '^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,6})?$';
const usdAmountRegExp = new RegExp(usdAmountPattern);
// Longer than any amount that fits maxMicroUsd; keeps BigInt parsing bounded
const maxUsdAmountLength = 26;

export type RoundingMode = 'floor' | 'ceil';

export class InvalidAmountError extends ServiceRouterError {
  readonly code = 'invalid_amount';
}

export class InexactAmountError extends ServiceRouterError {
  readonly code = 'inexact_amount';
}

export const isUsdAmount = (value: string): boolean =>
  value.length <= maxUsdAmountLength && usdAmountRegExp.test(value);

/** Parses a USD decimal string, such as `"0.001"`, into micro-USD. */
export const parseUsd = (value: string): MicroUsd => {
  if (!isUsdAmount(value))
    throw new InvalidAmountError('A USD amount must be a plain decimal with at most 6 fractional digits');

  const [whole = '', fraction = ''] = value.split('.');
  const amount = BigInt(whole) * 10n ** BigInt(usdDecimals) + BigInt(fraction.padEnd(usdDecimals, '0'));
  if (amount > maxMicroUsd)
    throw new InvalidAmountError('The USD amount is too large');

  return amount;
};

/** Formats micro-USD as the shortest exact decimal string, such as `"0.001"` or `"12"`. */
export const formatUsd = (amount: MicroUsd): string => {
  const sign = amount < 0n ? '-' : '';
  const absolute = amount < 0n ? -amount : amount;
  const unit = 10n ** BigInt(usdDecimals);
  const whole = absolute / unit;
  const fraction = (absolute % unit).toString().padStart(usdDecimals, '0').replace(/0+$/, '');

  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
};

export interface ConversionOptions {
  // The asset's decimals, from the asset registry
  readonly decimals: number;
  // Required when the conversion isn't exact. There is no default rounding.
  readonly rounding?: RoundingMode;
}

const assertDecimals = (decimals: number): void => {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > maxAssetDecimals)
    throw new InvalidAmountError(`Asset decimals must be an integer from 0 to ${maxAssetDecimals}`);
};

const rescale = (amount: bigint, fromDecimals: number, toDecimals: number, rounding: RoundingMode | undefined): bigint => {
  if (toDecimals >= fromDecimals)
    return amount * 10n ** BigInt(toDecimals - fromDecimals);

  const divisor = 10n ** BigInt(fromDecimals - toDecimals);
  // BigInt division truncates toward zero
  const quotient = amount / divisor;
  if (amount % divisor === 0n)
    return quotient;
  if (!rounding)
    throw new InexactAmountError('The amount is not exact in the target precision; pass a rounding mode');
  if (rounding === 'floor')
    return amount < 0n ? quotient - 1n : quotient;

  return amount > 0n ? quotient + 1n : quotient;
};

/** Converts micro-USD to an asset's atomic units. Pegged stablecoins only: 1 unit = 1 USD. */
export const usdToAtomic = (amount: MicroUsd, { decimals, rounding }: ConversionOptions): bigint => {
  assertDecimals(decimals);

  return rescale(amount, usdDecimals, decimals, rounding);
};

/** Converts an asset's atomic units to micro-USD. Pegged stablecoins only: 1 unit = 1 USD. */
export const atomicToUsd = (amount: bigint, { decimals, rounding }: ConversionOptions): MicroUsd => {
  assertDecimals(decimals);

  return rescale(amount, decimals, usdDecimals, rounding);
};
