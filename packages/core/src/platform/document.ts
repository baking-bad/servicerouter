// The platform config file as written: one per deployment (PC-1). Fields that end up as secrets hold
// the name of an environment variable, never the value (PC-3).

export type Environment = 'staging' | 'production';
export type LoggerLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface PlatformUrlsDocument {
  readonly website: string;
  readonly api: string;
  readonly pay: string;
}

export interface KeyPrefixesDocument {
  readonly master: string;
  readonly payment: string;
}

export interface AssetDocument {
  readonly name: string;
  readonly network: string;
  // ERC-20 contract, Solana mint, or Cardano `<policy ID>.<asset name>`
  readonly address: string;
  readonly decimals: number;
  // Only USD-pegged stablecoins are supported: 1 unit = 1 USD
  readonly peg: 'usd';
  // Calls cheaper than this don't offer the asset, because its network fee would exceed the price
  readonly minPrice?: string;
  readonly payTo: string;
}

export interface CdpAuthDocument {
  readonly type: 'cdp';
  readonly apiKeyId: string;
  readonly apiKeySecret: string;
}

export interface FacilitatorDocument {
  readonly name: string;
  readonly url: string;
  readonly networks: readonly string[];
  readonly auth?: CdpAuthDocument;
  // Default: true. A disabled facilitator isn't checked, and its networks aren't offered.
  readonly enabled?: boolean;
}

export interface MppDocument {
  readonly network: string;
  readonly recipient: string;
  // Default: true. A disabled MPP isn't offered, and its RPC isn't checked.
  readonly enabled?: boolean;
  // The Tempo RPC, without credentials. Default: the chain's public RPC.
  readonly rpcUrl?: string;
}

export interface PayoutsDocument {
  readonly assets: readonly string[];
  readonly minimum?: string;
}

export interface CategoryDocument {
  readonly id: string;
  readonly title: string;
}

export interface RateLimitDocument {
  readonly requests: number;
  readonly windowSeconds: number;
}

export interface RateLimitsDocument {
  readonly paymentKey: RateLimitDocument;
  readonly service: RateLimitDocument;
  readonly unpaidIp: RateLimitDocument;
  readonly signup: RateLimitDocument;
}

export interface TimeoutsDocument {
  readonly connectMs?: number;
  readonly requestMs?: number;
  readonly settleMs?: number;
}

export interface SizeLimitsDocument {
  readonly requestBodyBytes?: number;
  readonly bufferedResponseBytes?: number;
}

export interface SignerLimitsDocument {
  readonly maxPerCall?: string;
  readonly maxPerNetworkPerHour?: string;
  readonly maxPerNetworkPerDay?: string;
}

export interface SmtpDocument {
  readonly host: string;
  readonly port: number;
  readonly from: string;
  readonly username: string;
  readonly password: string;
}

export interface PlatformConfigDocument {
  readonly version: 1;
  readonly environment: Environment;
  readonly logger?: { readonly level?: LoggerLevel };
  readonly urls: PlatformUrlsDocument;
  // Extra hosts and IP addresses we own. The hosts of `urls` are always included.
  readonly ownHosts?: readonly string[];
  readonly keyPrefixes: KeyPrefixesDocument;
  readonly paymentKeyDefaults?: { readonly dailyBudget?: string };
  readonly feeBps: number;
  readonly routingFeeBps: number;
  readonly assets: readonly AssetDocument[];
  readonly facilitators: readonly FacilitatorDocument[];
  readonly mpp: MppDocument;
  readonly payouts: PayoutsDocument;
  readonly categories: readonly CategoryDocument[];
  readonly rateLimits: RateLimitsDocument;
  readonly timeouts?: TimeoutsDocument;
  readonly sizeLimits?: SizeLimitsDocument;
  readonly signer?: SignerLimitsDocument;
  readonly smtp?: SmtpDocument;
}
