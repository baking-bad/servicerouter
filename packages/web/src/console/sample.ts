import { ApiError } from '../api/http';
import { formatMicroUsd, parseUsd } from '../money';
import type { ConsoleApi } from './api';
import type { Account, Earnings, KeyLimits, OwnedService, Payment, PaymentKey, Revision, ServiceDetail, ServiceStatus } from './types';

// The console with sample data (WB-10): an account to look around in without signing up. Everything here
// is invented and lives in the tab's memory. Payments are drawn from a fixed seed, so the same day
// always looks the same.

const dayMs = 86_400_000;

// A small fixed-seed generator: the sample stays the same from load to load
const seeded = (seed: number) => {
  let state = seed;

  return (): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;

    return state / 2_147_483_648;
  };
};

/** The upstream hosts of a config, from its `baseUrl` lines. */
const upstreamHosts = (configText: string): readonly string[] =>
  [...new Set([...configText.matchAll(/baseUrl:\s*["']?(https:\/\/[^\s"']+)/g)].map(match => new URL(match[1]!).host))];

/** OV-7's status for a service, every host verified: sample data (WB-10). */
export const sampleStatus = (service: Pick<ServiceDetail, 'id' | 'state' | 'revision' | 'config' | 'updatedAt'>): ServiceStatus => ({
  id: service.id,
  state: service.state,
  revision: service.revision,
  verificationToken: `sr-verify=${[...service.id].map(char => char.charCodeAt(0).toString(16)).join('').padEnd(32, '0').slice(0, 32)}`,
  hosts: (upstreamHosts(service.config.text).length > 0 ? upstreamHosts(service.config.text) : ['api.example.com'])
    .map(host => ({ host, state: 'verified' as const, checkedAt: service.updatedAt, problem: null, missingSince: null, suspendsAt: null })),
  payoutConfirmation: null,
  notices: [],
});

/** CI-4's numbers for one of the seller's services, over 30 days: sample data (WB-10), until the console reads the catalog's. */
export const sampleServiceStats = (id: string): { readonly calls30d: number; readonly successRate: number; readonly p50Ms: number; readonly p95Ms: number } => {
  const random = seeded([...id].reduce((sum, char) => sum + char.charCodeAt(0), 0));

  return { calls30d: Math.round(20_000 + random() * 180_000), successRate: 0.97 + random() * 0.029, p50Ms: Math.round(40 + random() * 200), p95Ms: Math.round(250 + random() * 600) };
};

const sampleConfig = (id: string, title: string, host: string, price: string) => `servicerouter:
  version: "1"

service:
  id: ${id}
  title: ${title}
  description: A sample service.
  category: weather

payouts:
  default:
    asset: cardano-usdm
    address: addr1v9zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3q09h6pt

payments:
  default:
    amount: "${price}"

upstreams:
  - baseUrl: https://${host}
    openapi: https://${host}/openapi.json
    auth: main-key

credentials:
  main-key:
    type: http
    scheme: bearer
    secret: upstream-key
`;

const keyOf = (overrides: Partial<PaymentKey> & Pick<PaymentKey, 'id' | 'createdAt'>): PaymentKey => ({
  label: null, allowance: null, dailyBudget: '5', maxPrice: null, expiresAt: null, revokedAt: null,
  spent: { today: '0', total: '0' }, remaining: { allowance: null, dailyBudget: '5' }, ...overrides,
});

/** A console API over sample data, changed in memory by what the visitor does. */
export const createSampleConsoleApi = (now: () => Date = () => new Date()): ConsoleApi => {
  const today = now().getTime();
  const iso = (offsetMs: number): string => new Date(today - offsetMs).toISOString();
  const random = seeded(20_261_006);
  const bought = [
    { serviceId: 'chain-rpc', routeKey: 'ethRpc', price: '0.0005', weight: 0.45 },
    { serviceId: 'skycast-weather', routeKey: 'getCurrent', price: '0.001', weight: 0.25 },
    { serviceId: 'web-search-lite', routeKey: 'search', price: '0.003', weight: 0.18 },
    { serviceId: 'pixel-forge', routeKey: 'createImage', price: '0.04', weight: 0.07 },
    { serviceId: 'lingua-translate', routeKey: 'translate', price: '0.001', weight: 0.05 },
  ] as const;
  const rails = ['credits', 'credits', 'credits', 'credits', 'x402', 'mpp'] as const;
  const payments: Payment[] = Array.from({ length: 640 }, (_, index): Payment => {
    const pick = random();
    let total = 0;
    const service = bought.find(candidate => (total += candidate.weight) >= pick) ?? bought[0];
    const age = Math.floor(random() ** 1.6 * 30 * dayMs);
    const roll = random();
    const status = roll < 0.03 ? 'released' : roll < 0.04 ? 'held' : 'captured';
    const rail = rails[Math.floor(random() * rails.length)]!;

    return {
      id: `pay_sample_${index.toString().padStart(4, '0')}`,
      requestId: `req_sample_${index}`,
      kind: 'service',
      rail,
      serviceId: service.serviceId,
      routeKey: service.routeKey,
      targetHost: null,
      targetPath: null,
      amount: service.price,
      status: rail === 'credits' ? status : status === 'captured' ? 'settled' : 'cancelled',
      createdAt: iso(age),
      updatedAt: iso(age),
    };
  }).sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  let keys: PaymentKey[] = [
    keyOf({ id: 'key_sample_research', label: 'research-agent', dailyBudget: '5', allowance: '50', maxPrice: '0.05', createdAt: iso(25 * dayMs), spent: { today: '0.412', total: '18.904' }, remaining: { allowance: '31.096', dailyBudget: '4.588' } }),
    keyOf({ id: 'key_sample_ci', label: 'ci-bot', dailyBudget: '1', maxPrice: '0.001', createdAt: iso(12 * dayMs), expiresAt: iso(-60 * dayMs), spent: { today: '0.031', total: '2.210' }, remaining: { allowance: null, dailyBudget: '0.969' } }),
    keyOf({ id: 'key_sample_old', label: 'old-laptop', createdAt: iso(29 * dayMs), revokedAt: iso(20 * dayMs), spent: { today: '0', total: '0.840' } }),
  ];
  const services: OwnedService[] = [
    { id: 'skycast-weather', state: 'live', revision: 3, title: 'Skycast Weather', createdAt: iso(28 * dayMs), updatedAt: iso(2 * dayMs) },
    { id: 'geo-lookup', state: 'live', revision: 1, title: 'Geo Lookup', createdAt: iso(10 * dayMs), updatedAt: iso(10 * dayMs) },
  ];
  const revisions = new Map<string, Revision[]>([
    ['skycast-weather', [3, 2, 1].map(number => ({ number, active: number === 3, mediaType: 'application/yaml', createdBy: 'acc_sample', createdAt: iso((number === 3 ? 2 : number === 2 ? 9 : 28) * dayMs) }))],
    ['geo-lookup', [{ number: 1, active: true, mediaType: 'application/yaml', createdBy: 'acc_sample', createdAt: iso(10 * dayMs) }]],
  ]);
  const earnings: Record<string, Earnings> = {
    'skycast-weather': { serviceId: 'skycast-weather', calls: 243_650, earned: { total: '297.4113', byRail: { credits: '231.6045', x402: '48.0306', mpp: '17.7762' } }, fee: '7.6261', paidOut: '210', pending: '87.4113', nextPayoutDate: new Date(Date.UTC(now().getUTCFullYear(), now().getUTCMonth() + 1, 1)).toISOString().slice(0, 10) },
    'geo-lookup': { serviceId: 'geo-lookup', calls: 41_700, earned: { total: '20.3288', byRail: { credits: '20.3288' } }, fee: '0.5212', paidOut: '0', pending: '20.3288', nextPayoutDate: new Date(Date.UTC(now().getUTCFullYear(), now().getUTCMonth() + 1, 1)).toISOString().slice(0, 10) },
  };
  const account: Account = { id: 'acc_sample', email: null, emailConfirmed: false, topupUrl: null, depositAddress: null, createdAt: iso(29 * dayMs) };
  let created = 0;
  const find = <TValue>(value: TValue | undefined): TValue => {
    if (value === undefined)
      throw new ApiError(404, 'not_found', 'Not found');

    return value;
  };
  const withLimits = (key: PaymentKey, limits: KeyLimits): PaymentKey => {
    const spentToday = parseUsd(key.spent.today) ?? 0n;
    const spentTotal = parseUsd(key.spent.total) ?? 0n;
    const dailyBudget = limits.dailyBudget ?? key.dailyBudget;
    const allowance = limits.allowance === undefined ? key.allowance : limits.allowance;
    const left = (limit: string, spent: bigint) => formatMicroUsd(((parseUsd(limit) ?? 0n) > spent ? (parseUsd(limit) ?? 0n) - spent : 0n));

    return {
      ...key,
      label: limits.label === undefined ? key.label : limits.label,
      dailyBudget,
      allowance,
      maxPrice: limits.maxPrice === undefined ? key.maxPrice : limits.maxPrice,
      expiresAt: limits.expiresAt === undefined ? key.expiresAt : limits.expiresAt,
      remaining: { dailyBudget: left(dailyBudget, spentToday), allowance: allowance === null ? null : left(allowance, spentTotal) },
    };
  };

  return {
    sample: true,
    account: async () => account,
    balance: async () => ({ available: '42.3815', held: '0.0035' }),
    keys: async () => keys,
    createKey: async limits => {
      created += 1;
      const key = withLimits(keyOf({ id: `key_sample_new_${created}`, createdAt: now().toISOString() }), limits);
      keys = [key, ...keys];

      return { ...key, key: `sr_live_sample${'0'.repeat(30)}${created}` };
    },
    updateKey: async (id, limits) => {
      const key = withLimits(find(keys.find(candidate => candidate.id === id)), limits);
      keys = keys.map(candidate => candidate.id === id ? key : candidate);

      return key;
    },
    revokeKey: async id => {
      find(keys.find(candidate => candidate.id === id));
      keys = keys.map(candidate => candidate.id === id ? { ...candidate, revokedAt: now().toISOString() } : candidate);
    },
    payments: async ({ after, limit = 50 } = {}) => {
      const start = after === undefined ? 0 : Number(after);
      const page = payments.slice(start, start + limit);

      return { payments: page, next: start + limit < payments.length ? String(start + limit) : null };
    },
    services: async () => services,
    service: async id => {
      const service = find(services.find(candidate => candidate.id === id));
      const host = `${id}.example.com`;

      return {
        id, state: service.state, revision: service.revision ?? 1, createdAt: service.createdAt, updatedAt: service.updatedAt,
        config: { mediaType: 'application/yaml', text: sampleConfig(id, service.title ?? id, host, id === 'skycast-weather' ? '0.001' : '0.0005') },
        secrets: [{ name: 'upstream-key', updatedAt: service.updatedAt }],
      };
    },
    revisions: async id => find(revisions.get(id)),
    rollback: async (id, revision) => {
      const list = find(revisions.get(id));
      find(list.find(candidate => candidate.number === revision));
      revisions.set(id, list.map(candidate => ({ ...candidate, active: candidate.number === revision })));
      const service = find(services.find(candidate => candidate.id === id));
      services.splice(services.indexOf(service), 1, { ...service, revision });

      return { revision, state: service.state };
    },
    earnings: async id => find(earnings[id]),
    status: async service => ({ value: sampleStatus(service), sample: true }),
    verify: async service => ({ value: sampleStatus(service), sample: true }),
    serviceStats: async id => ({ value: sampleServiceStats(id), sample: true }),
    rotateMasterKey: async () => `srm_live_sample${'0'.repeat(30)}${Date.now() % 1_000}`,
  };
};
