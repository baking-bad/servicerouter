import { cryptoRandomSource, type RandomSource } from '../accounts/keys.js';

export const verificationTokenPrefix = 'sr-verify=';
export const confirmationTokenPrefix = 'sr-confirm=';
// 16 random bytes, in hex
const tokenBytes = 16;

const randomHex = (random: RandomSource): string => {
  const bytes = random.bytes(tokenBytes);
  if (bytes.length !== tokenBytes)
    throw new Error(`The random source returned ${bytes.length} bytes instead of ${tokenBytes}`);

  return Buffer.from(bytes).toString('hex');
};

/** An account's verification token (OV-1). It isn't a secret: only a host's owner can publish it there. */
export const generateVerificationToken = (random: RandomSource = cryptoRandomSource): string => `${verificationTokenPrefix}${randomHex(random)}`;

/** A payout confirmation token, bound to one waiting payout change (OV-10). */
export const generateConfirmationToken = (random: RandomSource = cryptoRandomSource): string => `${confirmationTokenPrefix}${randomHex(random)}`;
