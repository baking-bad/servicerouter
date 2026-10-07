import { ApiError, callApi } from '../api/http';
import type { CatalogStats } from '../api/types';
import type {
  Account, Balance, CreatedKey, Earnings, KeyLimits, OwnedService, PaymentKey, PaymentPage, Revision, ServiceDetail, ServiceStatus, Signup,
} from './types';

// The console's calls (WB-8). In the browser they go straight to the Platform API with the master key in
// Authorization (WB-2): the web server never sees the key.

/** What the console reads and changes, from the Platform API or from sample data (WB-10). */
export interface ConsoleApi {
  readonly sample: boolean;
  account(): Promise<Account>;
  balance(): Promise<Balance>;
  keys(): Promise<readonly PaymentKey[]>;
  createKey(limits: KeyLimits): Promise<CreatedKey>;
  updateKey(id: string, limits: KeyLimits): Promise<PaymentKey>;
  revokeKey(id: string): Promise<void>;
  payments(page?: { readonly after?: string; readonly limit?: number }): Promise<PaymentPage>;
  services(): Promise<readonly OwnedService[]>;
  service(id: string): Promise<ServiceDetail>;
  revisions(id: string): Promise<readonly Revision[]>;
  rollback(id: string, revision: number): Promise<{ readonly revision: number; readonly state: string }>;
  earnings(id: string): Promise<Earnings>;
  // Ownership status (OV-7). Sample data only in the sample console (WB-10).
  status(service: ServiceDetail): Promise<{ readonly value: ServiceStatus; readonly sample: boolean }>;
  /** Checks every upstream host now (OV-6), and returns the new status. */
  verify(service: ServiceDetail): Promise<{ readonly value: ServiceStatus; readonly sample: boolean }>;
  /** The service's last 30 days from the public catalog (CI-4). Undefined until it's live and indexed. */
  serviceStats(id: string): Promise<{ readonly value: CatalogStats | undefined; readonly sample: boolean }>;
  /** A new master key, shown once. The old one stops working at once. */
  rotateMasterKey(): Promise<string>;
}

export interface HttpConsoleOptions {
  readonly apiUrl: string;
  readonly key: string;
  readonly fetch?: typeof fetch;
}

const path = (id: string): string => `/v1/services/${encodeURIComponent(id)}`;

export const createHttpConsoleApi = ({ apiUrl, key, fetch: fetchFn }: HttpConsoleOptions): ConsoleApi => {
  const call = <TResult>(method: string, route: string, body?: unknown): Promise<TResult> =>
    callApi<TResult>(apiUrl, { method, path: route, key, ...(body === undefined ? {} : { body }), ...(fetchFn ? { fetch: fetchFn } : {}) });

  return {
    sample: false,
    account: () => call('GET', '/v1/account'),
    balance: () => call('GET', '/v1/balance'),
    keys: async () => (await call<{ readonly keys: readonly PaymentKey[] }>('GET', '/v1/keys')).keys,
    createKey: limits => call('POST', '/v1/keys', limits),
    updateKey: (id, limits) => call('PATCH', `/v1/keys/${encodeURIComponent(id)}`, limits),
    revokeKey: async id => {
      await call('DELETE', `/v1/keys/${encodeURIComponent(id)}`);
    },
    payments: ({ after, limit = 50 } = {}) => call('GET', `/v1/payments?limit=${limit}${after ? `&after=${encodeURIComponent(after)}` : ''}`),
    services: async () => (await call<{ readonly services: readonly OwnedService[] }>('GET', '/v1/services')).services,
    service: id => call('GET', path(id)),
    revisions: async id => (await call<{ readonly revisions: readonly Revision[] }>('GET', `${path(id)}/revisions`)).revisions,
    rollback: (id, revision) => call('POST', `${path(id)}/rollback`, { revision }),
    earnings: id => call('GET', `${path(id)}/earnings`),
    status: async service => ({ value: await call<ServiceStatus>('GET', `${path(service.id)}/status`), sample: false }),
    verify: async service => ({ value: await call<ServiceStatus>('POST', `${path(service.id)}/verify`), sample: false }),
    // The catalog is public: no key goes with it
    serviceStats: async id => {
      try {
        const entry = await callApi<{ readonly stats: CatalogStats }>(apiUrl, { path: `/v1/catalog/${encodeURIComponent(id)}`, ...(fetchFn ? { fetch: fetchFn } : {}) });

        return { value: entry.stats, sample: false };
      }
      catch (error) {
        if (error instanceof ApiError && error.status === 404)
          return { value: undefined, sample: false };
        throw error;
      }
    },
    rotateMasterKey: async () => (await call<{ readonly masterKey: string }>('POST', '/v1/account/master-key/rotate')).masterKey,
  };
};

/** The same API, calling `onUnauthorized` when any call answers 401: the key was rotated or is wrong (WB-8). */
export const signingOutOnUnauthorized = (api: ConsoleApi, onUnauthorized: () => void): ConsoleApi => {
  const wrapped: Record<string, unknown> = { ...api };
  for (const [name, member] of Object.entries(api)) {
    if (typeof member !== 'function')
      continue;
    wrapped[name] = async (...args: unknown[]) => {
      try {
        return await (member as (...input: unknown[]) => Promise<unknown>)(...args);
      }
      catch (error) {
        if (error instanceof ApiError && error.status === 401)
          onUnauthorized();
        throw error;
      }
    };
  }

  return wrapped as unknown as ConsoleApi;
};

/** `POST /v1/accounts`: a new account, and its master key shown once. */
export const signUp = (apiUrl: string, fetchFn?: typeof fetch): Promise<Signup> =>
  callApi<Signup>(apiUrl, { method: 'POST', path: '/v1/accounts', body: {}, ...(fetchFn ? { fetch: fetchFn } : {}) });
