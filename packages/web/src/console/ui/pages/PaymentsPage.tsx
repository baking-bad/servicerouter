'use client';

import { useState } from 'react';

import { paymentMethods, type PaymentMethod } from '../../../api/types';
import { methodInfo } from '../../../content';
import { displayUsd } from '../../../money';
import { paymentStatuses, type Payment, type PaymentStatus } from '../../types';
import { useConsole, useConsoleData } from '../ConsoleRoot';
import { ConsoleHeading, ErrorNotice } from '../parts';

const when = (iso: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(new Date(iso));

/** `/console/payments`: every payment, newest first, a page at a time, filtered by method and status. */
export const PaymentsPage = () => {
  const { api } = useConsole();
  const { data, error } = useConsoleData(consoleApi => consoleApi.payments({ limit: 50 }));
  const [more, setMore] = useState<{ readonly payments: readonly Payment[]; readonly next: string | null } | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [moreError, setMoreError] = useState<Error | undefined>(undefined);
  const [rail, setRail] = useState<PaymentMethod | ''>('');
  const [status, setStatus] = useState<PaymentStatus | ''>('');
  const payments = [...(data?.payments ?? []), ...(more?.payments ?? [])];
  const next = more ? more.next : data?.next ?? null;
  const shown = payments.filter(payment => (rail === '' || payment.rail === rail) && (status === '' || payment.status === status));

  return (
    <>
      <ConsoleHeading title="Payments" />
      <ErrorNotice error={error ?? moreError} />
      <div className="filters">
        <select className="select" value={rail} onChange={event => setRail(event.target.value as PaymentMethod | '')} aria-label="Payment method">
          <option value="">Every payment method</option>
          {paymentMethods.map(method => <option key={method} value={method}>{methodInfo[method].title}</option>)}
        </select>
        <select className="select" value={status} onChange={event => setStatus(event.target.value as PaymentStatus | '')} aria-label="Status">
          <option value="">Every status</option>
          {paymentStatuses.map(value => <option key={value} value={value}>{value}</option>)}
        </select>
        <span className="faint">{shown.length} of {payments.length} loaded</span>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>When (UTC)</th><th>Service</th><th>Route</th><th>Method</th><th>Status</th><th className="num">Amount</th><th>Payment</th></tr></thead>
          <tbody>
            {shown.map(payment => (
              <tr key={payment.id}>
                <td>{when(payment.createdAt)}</td>
                <td className="mono">{payment.serviceId ? <a href={`/discover/${payment.serviceId}`}>{payment.serviceId}</a> : payment.targetHost}</td>
                <td className="mono faint">{payment.routeKey ?? payment.targetPath}</td>
                <td>{methodInfo[payment.rail].short}</td>
                <td><span className={payment.status === 'captured' || payment.status === 'settled' ? 'badge badge-mint' : 'badge'}>{payment.status}</span></td>
                <td className="num">{displayUsd(payment.amount)}</td>
                <td className="mono faint">{payment.id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && payments.length === 0 ? <div className="card muted mt-16">No payments yet.</div> : null}
      {next !== null
        ? (
          <div className="row mt-16">
            <button
              type="button"
              className="button"
              disabled={loading}
              onClick={async () => {
                setLoading(true);
                setMoreError(undefined);
                try {
                  const page = await api!.payments({ limit: 50, after: next });
                  setMore({ payments: [...(more?.payments ?? []), ...page.payments], next: page.next });
                }
                catch (caught) {
                  setMoreError(caught instanceof Error ? caught : new Error(String(caught)));
                }
                finally {
                  setLoading(false);
                }
              }}
            >
              {loading ? 'Loading…' : 'Load older payments'}
            </button>
          </div>
        )
        : null}
    </>
  );
};
