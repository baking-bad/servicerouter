// The public Platform API's response shapes the website reads (WB-2). The catalog's are CI-5's, the
// top-up's DP-5's. Sample data has exactly these shapes (WB-10). Amounts are USD decimal strings.

export const paymentMethods = ['credits', 'x402', 'mpp'] as const;
export type PaymentMethod = typeof paymentMethods[number];

export const catalogSorts = ['popular', 'price', 'newest', 'success'] as const;
export type CatalogSort = typeof catalogSorts[number];

/** CI-4: a service's or route's numbers over the last 30 days. */
export interface CatalogStats {
  readonly calls30d: number;
  // 0 to 1
  readonly successRate: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
}

/** One service in `GET /v1/catalog` (CI-5). */
export interface CatalogItem {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly category: string;
  readonly tags: readonly string[];
  // The cheapest route's price
  readonly priceFrom: string;
  readonly currency: 'USD';
  readonly methods: readonly PaymentMethod[];
  readonly stats: CatalogStats;
  // Registered and verified, as opposed to a routed endpoint (AR14)
  readonly verified: boolean;
  readonly updatedAt: string;
  // A routed endpoint's routing link (CI-2). Its ID is `routed:<host><path>`, with no page of its own.
  readonly link?: string;
}

export interface CatalogCategory {
  readonly id: string;
  readonly title: string;
  // Services in it, its subcategories included
  readonly count: number;
}

/** `GET /v1/catalog` (CI-5). */
export interface CatalogPage {
  readonly services: readonly CatalogItem[];
  readonly categories: readonly CatalogCategory[];
  readonly next: string | null;
}

export interface CatalogRoute {
  readonly key: string;
  readonly method: string;
  // The path after /service/<id>
  readonly path: string;
  readonly summary: string;
  readonly price: string;
  readonly methods: readonly PaymentMethod[];
  readonly stats: CatalogStats;
}

/** `GET /v1/catalog/{id}` (CI-5). */
export interface CatalogService extends CatalogItem {
  readonly description: string;
  readonly links: { readonly homepage?: string; readonly docs?: string };
  readonly contact: { readonly name?: string; readonly url?: string; readonly email?: string };
  readonly routes: readonly CatalogRoute[];
  // The generated agent documents (AD-1, AD-2, AR1)
  readonly docs: { readonly openapi: string; readonly llms: string; readonly skill: string };
  // https://pay.servicerouter.ai/service/<id>
  readonly payUrl: string;
}

/** The catalog's query (CI-5). */
export interface CatalogQuery {
  // A category ID; its subcategories match too
  readonly category?: string;
  readonly q?: string;
  readonly method?: PaymentMethod;
  // USD: the cheapest route costs at most this
  readonly maxPrice?: string;
  readonly sort: CatalogSort;
  readonly limit?: number;
  readonly cursor?: string;
}

export const depositStatuses = ['confirming', 'credited', 'not_credited', 'dropped'] as const;
export type DepositStatus = typeof depositStatuses[number];

export interface Deposit {
  readonly transactionHash: string;
  readonly outputIndex: number;
  // The USD it credits, or null for an output without the deposit asset
  readonly amount: string | null;
  readonly status: DepositStatus;
  readonly confirmations: number;
  readonly confirmationsRequired: number;
  readonly seenAt: string;
  readonly creditedAt: string | null;
}

/** `GET /v1/topup/{token}` (DP-5): where to send funds, and what arrived. */
export interface Topup {
  readonly address: string;
  readonly asset: { readonly name: string; readonly symbol: string; readonly network: string; readonly networkTitle: string };
  readonly confirmationsRequired: number;
  // The latest 20, newest first
  readonly deposits: readonly Deposit[];
}

/** An answer, and whether it is sample data, which the page labels (WB-10). */
export interface Sourced<TValue> {
  readonly value: TValue;
  readonly sample: boolean;
}

/** A Platform API error (PA-3). */
export interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}
