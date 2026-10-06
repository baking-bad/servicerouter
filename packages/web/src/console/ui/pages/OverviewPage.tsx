'use client';

import Link from 'next/link';

import { methodInfo } from '../../../content';
import { shortDate } from '../../../format';
import { displayUsd, formatMicroUsd } from '../../../money';
import { loadRecentPayments, summarizeSpend, totalEarnings } from '../../spend';
import { BarList, SpendChart } from '../charts';
import { useConsole, useConsoleData } from '../ConsoleRoot';
import { ConsoleHeading, ErrorNotice, StatTile } from '../parts';

const usd = (micro: bigint) => displayUsd(formatMicroUsd(micro));

/** `/console/overview`: the balance, spend over 30 days, recent payments, and earnings for sellers (WB-8). */
export const OverviewPage = () => {
  const { api } = useConsole();
  const { data, error } = useConsoleData(async consoleApi => {
    const now = new Date();
    const [balance, recent, services] = await Promise.all([consoleApi.balance(), loadRecentPayments(consoleApi, now), consoleApi.services()]);
    const earnings = await Promise.all(services.map(service => consoleApi.earnings(service.id)));

    return { balance, recent, spend: summarizeSpend(recent.payments, now), services, earnings: services.length > 0 ? totalEarnings(earnings) : undefined };
  });

  if (error)
    return <><ConsoleHeading title="Overview" /><ErrorNotice error={error} /></>;
  if (!data || !api)
    return <><ConsoleHeading title="Overview" /><p className="faint">Loading…</p></>;
  const { balance, spend, recent, earnings } = data;
  const top = spend.byService.slice(0, 6);
  const rest = spend.byService.slice(6).reduce((sum, item) => sum + item.amount, 0n);

  return (
    <>
      <ConsoleHeading title="Overview" />
      <section className="stats">
        <StatTile label="Available" value={displayUsd(balance.available)} note={<Link href="/console/topup">Top up</Link>} />
        <StatTile label="Held for calls in flight" value={displayUsd(balance.held)} />
        <StatTile label="Spent today" value={usd(spend.today)} note="UTC day" />
        <StatTile label="Spent, 30 days" value={usd(spend.window)} note={`${spend.calls.toLocaleString('en-US')} paid calls`} />
      </section>

      <section className="section grid grid-2">
        <div className="card">
          <SpendChart days={spend.byDay} title="Spend per day, last 30 days" />
          {recent.complete ? null : <p className="faint">Counted over your latest 1,000 payments.</p>}
        </div>
        <div className="card">
          {top.length === 0
            ? <p className="muted">No paid calls in the last 30 days.</p>
            : (
              <BarList
                title="Where it went, 30 days"
                items={[
                  ...top.map(item => ({ key: item.serviceId, label: item.serviceId, href: `/discover/${item.serviceId}`, amount: item.amount, note: `${item.calls} calls` })),
                  ...(rest > 0n ? [{ key: 'other', label: 'Everything else', amount: rest }] : []),
                ]}
              />
            )}
        </div>
      </section>

      {earnings
        ? (
          <section className="section">
            <div className="section-head"><h2>Earnings from your services</h2><Link href="/console/services" className="muted">Services →</Link></div>
            <div className="stats">
              <StatTile label="Earned" value={displayUsd(earnings.earned)} note={`${earnings.calls.toLocaleString('en-US')} paid calls`} />
              <StatTile label="Pending payout" value={displayUsd(earnings.pending)} note={earnings.nextPayoutDate ? `Next payout ${shortDate(earnings.nextPayoutDate)}` : undefined} />
              <StatTile label="Paid out" value={displayUsd(earnings.paidOut)} />
              <StatTile label="Platform fee" value={displayUsd(earnings.fee)} />
            </div>
          </section>
        )
        : null}

      <section className="section">
        <div className="section-head"><h2>Recent payments</h2><Link href="/console/payments" className="muted">Every payment →</Link></div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>When</th><th>Service</th><th>Method</th><th>Status</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {recent.payments.slice(0, 6).map(payment => (
                <tr key={payment.id}>
                  <td>{shortDate(payment.createdAt)}</td>
                  <td className="mono">{payment.serviceId ?? payment.targetHost}</td>
                  <td>{methodInfo[payment.rail].short}</td>
                  <td>{payment.status}</td>
                  <td className="num">{displayUsd(payment.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
};
