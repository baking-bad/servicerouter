'use client';

import Link from 'next/link';

import { sellerSkillPath } from '../../../agents/guide';
import { sellerPrompt } from '../../../agents/prompts';
import { CopyText } from '../../../components/CopyText';
import { shortDate } from '../../../format';
import { displayUsd } from '../../../money';
import { useConsole, useConsoleData } from '../ConsoleRoot';
import { ConsoleHeading, ErrorNotice } from '../parts';

/** `/console/services`: the services you sell (GET /v1/services), with their earnings. */
export const ServicesPage = () => {
  const { settings } = useConsole();
  const { data, error } = useConsoleData(async consoleApi => {
    const services = await consoleApi.services();
    const earnings = await Promise.all(services.map(service => consoleApi.earnings(service.id)));

    return services.map((service, index) => ({ service, earnings: earnings[index]! }));
  });

  return (
    <>
      <ConsoleHeading title="Services" />
      <ErrorNotice error={error} />
      {data === undefined && !error ? <p className="faint">Loading…</p> : null}
      {data && data.length === 0
        ? (
          <div className="card stack">
            <h3>Sell your API here</h3>
            <p className="muted">You list a service by submitting its config with <code>PUT /v1/services/&lt;id&gt;</code>. Give your agent the seller skill, and it walks you through it:</p>
            <CopyText text={sellerPrompt({ siteUrl: settings.siteUrl })} />
            <a className="mono faint" href={sellerSkillPath}>Seller skill →</a>
          </div>
        )
        : null}
      {data && data.length > 0
        ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Service</th><th>State</th><th className="num">Revision</th><th className="num">Paid calls</th><th className="num">Earned</th><th className="num">Pending</th><th>Updated</th></tr></thead>
              <tbody>
                {data.map(({ service, earnings }) => (
                  <tr key={service.id}>
                    <td><Link href={`/console/services/${service.id}`}><strong>{service.title ?? service.id}</strong></Link><div className="mono faint">{service.id}</div></td>
                    <td><span className={service.state === 'live' ? 'badge badge-mint' : 'badge'}>{service.state}</span></td>
                    <td className="num">{service.revision ?? '–'}</td>
                    <td className="num">{earnings.calls.toLocaleString('en-US')}</td>
                    <td className="num">{displayUsd(earnings.earned.total)}</td>
                    <td className="num">{displayUsd(earnings.pending)}</td>
                    <td>{shortDate(service.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
        : null}
    </>
  );
};
