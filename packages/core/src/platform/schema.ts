import type { SchemaObject } from 'ajv';

import { assetNamePattern, networkIdPattern } from '@servicerouter/common';

import {
  array, boolean, constant, email, host, httpsOrigin, httpsUrl, httpUrl, integer, object, oneOfValues, text, usdAmount,
} from '../validation/schema.js';

const name: SchemaObject = {
  type: 'string', pattern: '^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$',
  errorMessage: 'must be 1–32 lowercase letters, digits, or hyphens, starting and ending with a letter or digit',
};
const assetName: SchemaObject = {
  type: 'string', pattern: assetNamePattern, maxLength: 64,
  errorMessage: 'must be lowercase letters and digits separated by single hyphens, such as base-usdc',
};
const networkId: SchemaObject = {
  type: 'string', pattern: networkIdPattern,
  errorMessage: 'must be a CAIP-2 network ID, such as eip155:8453',
};
const secretName: SchemaObject = {
  type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,127}$',
  errorMessage: 'must name the environment variable that holds the secret, such as CDP_API_KEY_SECRET. Never put the value here',
};
const keyPrefix: SchemaObject = {
  type: 'string', pattern: '^[a-z][a-z0-9_]{1,31}$',
  errorMessage: 'must be 2–32 lowercase letters, digits, or underscores, such as sr_live_',
};
const categoryId: SchemaObject = {
  type: 'string', maxLength: 64, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*$',
  errorMessage: 'must be a lowercase ID, optionally hierarchical, such as weather or finance/market-data',
};
const addressText = text(128);
const basisPoints = integer(0, 10_000);
const positive = integer(1);
const rateLimit = object({ requests: positive, windowSeconds: positive }, ['requests', 'windowSeconds']);

export const platformConfigSchema: SchemaObject = {
  $id: 'servicerouter-platform-config-v1',
  ...object({
    version: constant(1),
    environment: oneOfValues(['staging', 'production']),
    logger: object({ level: oneOfValues(['trace', 'debug', 'info', 'warn', 'error', 'fatal']) }),
    urls: object({ website: httpsOrigin, api: httpsOrigin, pay: httpsOrigin }, ['website', 'api', 'pay']),
    ownHosts: array(host, { uniqueItems: true }),
    keyPrefixes: object({ master: keyPrefix, payment: keyPrefix }, ['master', 'payment']),
    paymentKeyDefaults: object({ dailyBudget: usdAmount }),
    feeBps: basisPoints,
    routingFeeBps: basisPoints,
    assets: array(object({
      name: assetName,
      network: networkId,
      address: addressText,
      decimals: integer(0, 36),
      peg: constant('usd'),
      minPrice: usdAmount,
      payTo: addressText,
    }, ['name', 'network', 'address', 'decimals', 'peg', 'payTo']), { minItems: 1 }),
    facilitators: array(object({
      name,
      url: httpUrl,
      networks: array(networkId, { minItems: 1, uniqueItems: true }),
      auth: object({ type: constant('cdp'), apiKeyId: secretName, apiKeySecret: secretName }, ['type', 'apiKeyId', 'apiKeySecret']),
      enabled: boolean,
    }, ['name', 'url', 'networks']), { minItems: 1 }),
    mpp: object({ network: networkId, recipient: addressText, enabled: boolean, rpcUrl: httpsUrl }, ['network', 'recipient']),
    deposits: object({ asset: assetName, confirmations: integer(1, 2160), enabled: boolean, blockfrostUrl: httpUrl }, ['asset']),
    payouts: object({ assets: array(assetName, { minItems: 1, uniqueItems: true }), minimum: usdAmount }, ['assets']),
    categories: array(object({ id: categoryId, title: text(60) }, ['id', 'title']), { minItems: 1 }),
    rateLimits: object(
      { paymentKey: rateLimit, service: rateLimit, unpaidIp: rateLimit, signup: rateLimit, topup: rateLimit, documents: rateLimit },
      ['paymentKey', 'service', 'unpaidIp', 'signup'],
    ),
    timeouts: object({ connectMs: positive, requestMs: positive, settleMs: positive }),
    sizeLimits: object({ requestBodyBytes: positive, bufferedResponseBytes: positive }),
    signer: object({ maxPerCall: usdAmount, maxPerNetworkPerHour: usdAmount, maxPerNetworkPerDay: usdAmount }),
    smtp: object({
      host,
      port: integer(1, 65_535),
      from: email,
      username: secretName,
      password: secretName,
    }, ['host', 'port', 'from', 'username', 'password']),
  }, [
    'version', 'environment', 'urls', 'keyPrefixes', 'feeBps', 'routingFeeBps', 'assets', 'facilitators',
    'mpp', 'payouts', 'categories', 'rateLimits',
  ]),
};
