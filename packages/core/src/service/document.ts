// The service config a seller submits, format version 1 (Service registry, "Config format").

export interface ServiceInfoDocument {
  readonly id: string;
  readonly title: string;
  readonly summary?: string;
  readonly description: string;
  readonly category: string;
  readonly tags?: readonly string[];
  readonly links?: {
    readonly homepage?: string;
    readonly docs?: string;
  };
  readonly contact?: {
    readonly name?: string;
    readonly url?: string;
    readonly email?: string;
  };
}

export interface PayoutDocument {
  readonly asset: string;
  readonly address: string;
}

export interface PaymentDocument {
  // USD decimal string. Missing fields come from `payments.default`.
  readonly amount?: string;
}

export type PaymentsDocument = { readonly default: PaymentDocument & { readonly amount: string } } & Readonly<Record<string, PaymentDocument>>;

export type HttpMethod = 'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch' | 'trace';

export interface OperationDocument {
  readonly operationId?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly [field: string]: unknown;
}

export type PathItemDocument = Partial<Record<HttpMethod, OperationDocument>> & {
  readonly summary?: string;
  readonly description?: string;
  readonly parameters?: readonly unknown[];
  readonly servers?: readonly unknown[];
};

// An OpenAPI `paths` object
export type PathsDocument = Readonly<Record<string, PathItemDocument>>;

export interface UpstreamDocument {
  // HTTPS, public host, optional path prefix. A trailing slash is ignored.
  readonly baseUrl: string;
  readonly name?: string;
  readonly type?: 'http';
  // Exactly one of `openapi` and `paths`
  readonly openapi?: string;
  readonly paths?: PathsDocument;
  // Credential names. A list sends every credential.
  readonly auth?: string | readonly string[];
}

export interface RouteDocument {
  // A named payment, or an inline one
  readonly payment?: string | PaymentDocument;
  readonly target?: { readonly path: string };
  readonly enabled?: boolean;
}

export interface HttpCredentialDocument {
  readonly type: 'http';
  readonly scheme: 'bearer' | 'basic';
  // A secret name. The value is never inline (SR-12).
  readonly secret: string;
}

export interface ApiKeyCredentialDocument {
  readonly type: 'apiKey';
  readonly in: 'header' | 'query' | 'cookie';
  readonly name: string;
  readonly secret: string;
}

export type CredentialDocument = HttpCredentialDocument | ApiKeyCredentialDocument;

export interface ServiceConfigDocument {
  readonly servicerouter: { readonly version: '1' };
  readonly service: ServiceInfoDocument;
  readonly payouts: { readonly default: PayoutDocument };
  readonly payments: PaymentsDocument;
  readonly upstreams: readonly UpstreamDocument[];
  // Key: operationId, or <upstream>/<operationId> when two upstreams share an operationId
  readonly routes?: Readonly<Record<string, RouteDocument>>;
  readonly credentials?: Readonly<Record<string, CredentialDocument>>;
}
