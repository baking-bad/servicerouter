import { formatMicroUsd, parseUsd } from '../money';
import type { PaymentMethod } from '../api/types';
import type { ConsoleApi } from './api';
import type { Earnings, Payment } from './types';

// What the console computes in the browser (WB-8): a buyer's spend from their payments, and a seller's
// earnings across services. Integer micro-USD throughout (CK-4).

const dayMs = 86_400_000;
export const spendWindowDays = 30;
// Enough for the chart, without paging forever through a busy account
export const maxSpendPayments = 1_000;

/** Payments that cost the buyer money: captured (credits) and settled (x402, MPP). */
export const chargedStatuses: ReadonlySet<Payment['status']> = new Set(['captured', 'settled']);

/** The UTC day of an ISO time. */
export const utcDay = (iso: string): string => iso.slice(0, 10);

export interface SpendSummary {
  readonly today: bigint;
  readonly window: bigint;
  readonly calls: number;
  // One entry per UTC day of the window, oldest first, today last
  readonly byDay: readonly { readonly day: string; readonly amount: bigint; readonly calls: number }[];
  // Most spent first
  readonly byService: readonly { readonly serviceId: string; readonly amount: bigint; readonly calls: number }[];
}

/** Spend over the last 30 UTC days, today included, by day and by service. */
export const summarizeSpend = (payments: readonly Payment[], now: Date): SpendSummary => {
  const today = utcDay(now.toISOString());
  const days = Array.from({ length: spendWindowDays }, (_, index) => utcDay(new Date(now.getTime() - (spendWindowDays - 1 - index) * dayMs).toISOString()));
  const byDay = new Map(days.map(day => [day, { amount: 0n, calls: 0 }]));
  const byService = new Map<string, { amount: bigint; calls: number }>();
  for (const payment of payments) {
    const day = byDay.get(utcDay(payment.createdAt));
    if (!day || !chargedStatuses.has(payment.status))
      continue;
    const amount = parseUsd(payment.amount) ?? 0n;
    day.amount += amount;
    day.calls += 1;
    const key = payment.serviceId ?? payment.targetHost ?? 'other';
    const service = byService.get(key) ?? { amount: 0n, calls: 0 };
    service.amount += amount;
    service.calls += 1;
    byService.set(key, service);
  }
  const series = days.map(day => ({ day, ...byDay.get(day)! }));

  return {
    today: series.at(-1)?.day === today ? series.at(-1)!.amount : 0n,
    window: series.reduce((sum, day) => sum + day.amount, 0n),
    calls: series.reduce((sum, day) => sum + day.calls, 0),
    byDay: series,
    byService: [...byService].map(([serviceId, value]) => ({ serviceId, ...value })).sort((left, right) => (right.amount > left.amount ? 1 : right.amount < left.amount ? -1 : right.calls - left.calls)),
  };
};

/** The payments of the last 30 days, newest first, following pages up to 1,000. */
export const loadRecentPayments = async (api: Pick<ConsoleApi, 'payments'>, now: Date, max = maxSpendPayments): Promise<{ readonly payments: readonly Payment[]; readonly complete: boolean }> => {
  const since = new Date(now.getTime() - spendWindowDays * dayMs).toISOString();
  const payments: Payment[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await api.payments({ limit: 100, ...(after === undefined ? {} : { after }) });
    for (const payment of page.payments) {
      if (payment.createdAt < since)
        return { payments, complete: true };
      payments.push(payment);
      if (payments.length >= max)
        return { payments, complete: false };
    }
    if (page.next === null)
      return { payments, complete: true };
    after = page.next;
  }
};

export interface EarningsTotal {
  readonly calls: number;
  readonly earned: string;
  readonly fee: string;
  readonly pending: string;
  readonly paidOut: string;
  readonly byRail: Readonly<Partial<Record<PaymentMethod, string>>>;
  readonly nextPayoutDate: string | undefined;
}

/** A seller's earnings across their services: each service's `GET …/earnings`, added up. */
export const totalEarnings = (list: readonly Earnings[]): EarningsTotal => {
  const sum = (pick: (earnings: Earnings) => string | undefined) => formatMicroUsd(list.reduce((total, earnings) => total + (parseUsd(pick(earnings) ?? '0') ?? 0n), 0n));
  const rails = [...new Set(list.flatMap(earnings => Object.keys(earnings.earned.byRail)))] as PaymentMethod[];

  return {
    calls: list.reduce((total, earnings) => total + earnings.calls, 0),
    earned: sum(earnings => earnings.earned.total),
    fee: sum(earnings => earnings.fee),
    pending: sum(earnings => earnings.pending),
    paidOut: sum(earnings => earnings.paidOut),
    byRail: Object.fromEntries(rails.map(rail => [rail, sum(earnings => earnings.earned.byRail[rail])])),
    nextPayoutDate: list.map(earnings => earnings.nextPayoutDate).sort()[0],
  };
};
