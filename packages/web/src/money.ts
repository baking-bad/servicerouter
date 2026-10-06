// USD amounts arrive as decimal strings with up to 6 places (CK-4). Comparisons use integer micro-USD,
// never floating point.

const usdPattern = /^(0|[1-9]\d{0,11})(?:\.(\d{1,6}))?$/;

/** A USD decimal string as micro-USD, or undefined when it isn't one. */
export const parseUsd = (text: string): bigint | undefined => {
  const match = usdPattern.exec(text.trim());
  if (!match)
    return undefined;

  return BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'));
};

/** Micro-USD as the shortest decimal string, such as 1000n → "0.001". */
export const formatMicroUsd = (micro: bigint): string => {
  const sign = micro < 0n ? '-' : '';
  const value = micro < 0n ? -micro : micro;
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');

  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
};

/** A price for people: "$0.001", "$0.05", "$12.50". Cents get two places once there are whole dollars. */
export const displayUsd = (text: string): string => {
  const micro = parseUsd(text.replace(/^-/, ''));
  if (micro === undefined)
    return text;
  const negative = text.trim().startsWith('-') ? '-' : '';
  if (micro >= 1_000_000n) {
    const cents = (micro + 5_000n) / 10_000n;

    return `${negative}$${(cents / 100n).toLocaleString('en-US')}.${(cents % 100n).toString().padStart(2, '0')}`;
  }

  return `${negative}$${formatMicroUsd(micro)}`;
};
