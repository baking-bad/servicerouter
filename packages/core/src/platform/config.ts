import type { AssetName, MicroUsd, NetworkId } from '@servicerouter/common';

import type { NetworkInfo } from '../networks.js';
import type { Environment, LoggerLevel } from './document.js';

// The platform config as apps use it: defaults applied, amounts in micro-USD, deeply frozen.
// Secret fields keep the environment variable name; apps read values with `readSecret`.

export type SecretName = string;

export interface Asset {
  readonly name: AssetName;
  readonly network: NetworkInfo;
  readonly address: string;
  readonly decimals: number;
  readonly peg: 'usd';
  readonly minPrice: MicroUsd;
  readonly payTo: string;
}

export interface CdpAuth {
  readonly type: 'cdp';
  readonly apiKeyId: SecretName;
  readonly apiKeySecret: SecretName;
}

export interface Facilitator {
  readonly name: string;
  readonly url: string;
  readonly networks: readonly NetworkId[];
  readonly auth: CdpAuth | undefined;
  // A disabled facilitator isn't checked at startup or for readiness, and its networks aren't offered
  readonly enabled: boolean;
  // The platform's flat fee on each registered service's payment it settles, on top of feeBps's share (P-2)
  readonly feePerPayment: MicroUsd;
}

export interface Category {
  readonly id: string;
  readonly title: string;
}

export interface RateLimit {
  readonly requests: number;
  readonly windowSeconds: number;
}

export interface SmtpRelay {
  readonly host: string;
  readonly port: number;
  readonly from: string;
  readonly username: SecretName;
  readonly password: SecretName;
}

export interface PlatformConfig {
  readonly version: 1;
  readonly environment: Environment;
  readonly logger: { readonly level: LoggerLevel };
  readonly urls: {
    readonly website: string;
    readonly api: string;
    readonly pay: string;
  };
  // Lowercase hostnames and IP addresses, including the hosts of `urls`. Outbound HTTP refuses them (OH-5).
  readonly ownHosts: readonly string[];
  readonly keyPrefixes: {
    readonly master: string;
    readonly payment: string;
  };
  readonly paymentKeyDefaults: { readonly dailyBudget: MicroUsd };
  readonly feeBps: number;
  readonly routingFeeBps: number;
  readonly assets: readonly Asset[];
  readonly facilitators: readonly Facilitator[];
  readonly mpp: {
    readonly network: NetworkInfo;
    readonly recipient: string;
    // A disabled MPP isn't offered or checked, and its RPC isn't called (PR-9)
    readonly enabled: boolean;
    // The Tempo RPC the proxy and workers use. Undefined: the chain's public RPC.
    readonly rpcUrl: string | undefined;
  };
  // Buyers' Cardano deposit addresses (DP-1 to DP-4). Undefined: deposits are off.
  readonly deposits: {
    readonly asset: Asset;
    readonly network: NetworkInfo;
    readonly confirmations: number;
    readonly blockfrostUrl: string;
  } | undefined;
  readonly payouts: {
    readonly assets: readonly AssetName[];
    readonly minimum: MicroUsd;
  };
  readonly categories: readonly Category[];
  readonly rateLimits: {
    readonly paymentKey: RateLimit;
    readonly service: RateLimit;
    readonly unpaidIp: RateLimit;
    // POST /v1/accounts per client IP (PA-5)
    readonly signup: RateLimit;
    // GET /v1/topup/{token} per client IP (PA-5)
    readonly topup: RateLimit;
    // A service's agent documents per client IP (PA-5, AD-4)
    readonly documents: RateLimit;
    // Config assistant drafts per account (CA-1)
    readonly assistant: RateLimit;
  };
  readonly timeouts: {
    readonly connectMs: number;
    readonly requestMs: number;
    readonly settleMs: number;
  };
  readonly sizeLimits: {
    readonly requestBodyBytes: number;
    readonly bufferedResponseBytes: number;
  };
  readonly signer: {
    readonly maxPerCall: MicroUsd;
    readonly maxPerNetworkPerHour: MicroUsd | undefined;
    readonly maxPerNetworkPerDay: MicroUsd;
  };
  readonly smtp: SmtpRelay | undefined;
}
