import type { LoggerLevel } from './document.js';

// Documented defaults for optional platform config fields, kept in one place. Values without a
// documented default, such as fees and rate limits, are required in the file instead.
export const platformDefaults = {
  loggerLevel: 'info' satisfies LoggerLevel,
  // AR4: a new payment key gets $5 a day
  paymentKeyDailyBudget: '5',
  // B6: payouts below $10 roll over
  minimumPayout: '10',
  // An asset is offered for every price unless the deployment sets a minimum (PC-6)
  assetMinPrice: '0',
  // OH-4 and PR-12
  timeouts: { connectMs: 5_000, requestMs: 30_000, settleMs: 30_000 },
  // PX-8: request body 1 MiB. AR3: x402 response buffer 10 MiB.
  sizeLimits: { requestBodyBytes: 1024 * 1024, bufferedResponseBytes: 10 * 1024 * 1024 },
  // AR8: $1 per call, $100 a day per network. No hourly limit unless set.
  signer: { maxPerCall: '1', maxPerNetworkPerDay: '100' },
  // DP-3: blocks on top of a deposit's, its own included, before it is credited. About 5 minutes on Cardano.
  depositConfirmations: 15,
  // PA-5: GET /v1/topup/{token} per client IP
  topupRateLimit: { requests: 60, windowSeconds: 60 },
  // PA-5: a service's agent documents (AD-4) per client IP
  documentsRateLimit: { requests: 120, windowSeconds: 60 },
  // CA-1: drafts per account: each may cost a model call
  assistantRateLimit: { requests: 30, windowSeconds: 3600 },
  // DP-2: Blockfrost's base URL per network
  blockfrostUrls: {
    'cardano:mainnet': 'https://cardano-mainnet.blockfrost.io/api/v0',
    'cardano:preprod': 'https://cardano-preprod.blockfrost.io/api/v0',
    'cardano:preview': 'https://cardano-preview.blockfrost.io/api/v0',
  } as Readonly<Record<string, string>>,
} as const;
