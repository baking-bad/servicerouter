import { Secret } from '@servicerouter/common';
import { hashApiKey, isWellFormedKey, keyKindOf, type KeyPrefixes } from '@servicerouter/core';

import { MultiplePaymentMethodsError } from './errors.js';
import type { RequestHeaders } from './rail.js';

/**
 * The key in `Authorization: Bearer <key>`, told apart by its prefix before any lookup (AK-4). Only a
 * well-formed payment key carries its hash. The key itself never leaves detection.
 */
export type CreditsKey =
  | { readonly kind: 'payment'; readonly hash: string }
  | { readonly kind: 'master' }
  | { readonly kind: 'invalid' };

export interface CreditsCredential {
  readonly rail: 'credits';
  readonly key: CreditsKey;
}

/**
 * `PAYMENT-SIGNATURE` (x402 v2) or `X-PAYMENT` (v1), as sent: base64 of the payment payload. It
 * authorizes a transfer, so it stays in a Secret until the rail decodes it.
 */
export interface X402Credential {
  readonly rail: 'x402';
  readonly version: 1 | 2;
  readonly header: Secret;
}

/**
 * `Authorization: Payment …` (MPP), as sent. It carries a signed transfer, so it stays in a Secret
 * until the rail broadcasts or drops it.
 */
export interface MppCredential {
  readonly rail: 'mpp';
  readonly header: Secret;
}

export type Credential = CreditsCredential | X402Credential | MppCredential;

/** Finds one rail's credential in the request headers, or undefined (PR-1). */
export type CredentialDetector = (headers: RequestHeaders) => Credential | undefined;

const bearerPattern = /^Bearer[ \t]+(\S+)[ \t]*$/i;
const paymentSchemePattern = /^Payment(?:[ \t]|$)/i;

const single = (value: string | readonly string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : value?.[0];

const present = (value: string | readonly string[] | undefined): boolean => (single(value)?.trim() ?? '') !== '';

/** Credits: `Authorization: Bearer <key>`. Any bearer counts, so a master key gets `401 wrong_key_type`. */
export const createCreditsDetector = (keyPrefixes: KeyPrefixes): CredentialDetector => headers => {
  const token = bearerPattern.exec(single(headers['authorization']) ?? '')?.[1];
  if (token === undefined)
    return undefined;

  const kind = keyKindOf(token, keyPrefixes);
  if (kind === 'master')
    return { rail: 'credits', key: { kind: 'master' } };
  if (kind !== 'payment' || !isWellFormedKey(token, kind, keyPrefixes))
    return { rail: 'credits', key: { kind: 'invalid' } };

  const key = Secret.from(token);
  try {
    return { rail: 'credits', key: { kind: 'payment', hash: hashApiKey(key) } };
  }
  finally {
    key.destroy();
  }
};

/** x402: `PAYMENT-SIGNATURE` (v2), else `X-PAYMENT` (v1). Both at once are still one x402 payment. */
export const detectX402: CredentialDetector = headers => {
  const v2 = single(headers['payment-signature']);
  if (present(v2))
    return { rail: 'x402', version: 2, header: Secret.from(v2!.trim()) };
  const v1 = single(headers['x-payment']);

  return present(v1) ? { rail: 'x402', version: 1, header: Secret.from(v1!.trim()) } : undefined;
};

/** MPP: `Authorization: Payment …`. */
export const detectMpp: CredentialDetector = headers => {
  const value = single(headers['authorization']);

  return value !== undefined && paymentSchemePattern.test(value) ? { rail: 'mpp', header: Secret.from(value.trim()) } : undefined;
};

/**
 * The request's one payment credential, or undefined without one (PR-1). Throws
 * MultiplePaymentMethodsError for two or more.
 */
export const detectCredential = (detectors: readonly CredentialDetector[], headers: RequestHeaders): Credential | undefined => {
  const found = detectors.flatMap(detect => detect(headers) ?? []);
  if (found.length > 1)
    throw new MultiplePaymentMethodsError();

  return found[0];
};
