import { createHmac, createSecretKey } from 'node:crypto';

import { InvalidEnvironmentError, readSecret, type AppEnvironment, type Secret } from '@servicerouter/common';

export const buyerHeaderKeyVariable = 'BUYER_HEADER_KEY';
// Long enough that the HMAC can't be brute-forced back to a buyer
export const minimumBuyerHeaderKeyLength = 32;

// PX-15: tells the upstream which buyer calls, without saying who it is
export const buyerHeader = 'servicerouter-buyer';

/** The buyer header's value for a buyer, such as `account:<id>`, calling a service. */
export type BuyerHeaderValue = (buyer: string, serviceId: string) => string;

/**
 * PX-15: HMAC-SHA256 under the platform key of the buyer and the service ID, in base64url. Stable per
 * buyer and service, different across services, and meaningless without the key.
 */
export const createBuyerHeaderValue = (key: Secret): BuyerHeaderValue => {
  const hmacKey = createSecretKey(Buffer.from(key.expose(), 'utf8'));

  return (buyer, serviceId) => createHmac('sha256', hmacKey).update(`${buyer}\n${serviceId}`, 'utf8').digest('base64url');
};

/** BUYER_HEADER_KEY, the buyer header's HMAC key (PX-15). Throws when it is missing or shorter than 32 characters. */
export const readBuyerHeaderKey = (env: AppEnvironment): Secret => {
  const key = readSecret(buyerHeaderKeyVariable, env);
  if (key.expose().length < minimumBuyerHeaderKeyLength) {
    key.destroy();
    throw new InvalidEnvironmentError(`${buyerHeaderKeyVariable} must be at least ${minimumBuyerHeaderKeyLength} characters`);
  }

  return key;
};
