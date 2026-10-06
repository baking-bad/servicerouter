'use client';

import Link from 'next/link';
import { useState } from 'react';

import { methodInfo } from '../../../content';
import { compactCount, latency, percent, shortDate } from '../../../format';
import { displayUsd } from '../../../money';
import { SampleBadge } from '../../../components/SampleBadge';
import { sampleServiceStats } from '../../sample';
import type { HostState, HostStatus, ServiceDetail, ServiceStatus } from '../../types';
import { useConsole, useConsoleData } from '../ConsoleRoot';
import { ConfirmButton, ConsoleHeading, ErrorNotice, StatTile } from '../parts';

const hostLabels: Readonly<Record<HostState, string>> = { unverified: 'Unverified', verified: 'Verified', missing: 'Token missing', suspended: 'Suspended' };

/** What to do about a host, or when it was last seen fine (OV-4, OV-5). */
const hostNote = (host: HostStatus): string => {
  if (host.state === 'missing' && host.suspendsAt)
    return `Suspends ${shortDate(host.suspendsAt)}${host.problem ? `: ${host.problem}` : ''}`;
  if (host.problem)
    return host.problem;

  return host.checkedAt ? `Checked ${shortDate(host.checkedAt)}` : 'Not checked yet';
};

type Sourced = { readonly value: ServiceStatus; readonly sample: boolean };

/** The service's ownership status (OV-7): the token to publish, each host, a payout change waiting, and a check on demand (OV-6). */
const OwnershipCard = ({ detail, initial }: { readonly detail: ServiceDetail; readonly initial: Sourced }) => {
  const { api } = useConsole();
  const [status, setStatus] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const { value } = status;

  return (
    <div className="card stack">
      <div className="row"><h3>Ownership</h3><SampleBadge sample={status.sample} /></div>
      <p className="muted">Each upstream host serves <code>/.well-known/servicerouter.json</code> listing this token:</p>
      <code className="mono">{value.verificationToken}</code>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Host</th><th>State</th><th>Note</th></tr></thead>
          <tbody>{value.hosts.map(host => <tr key={host.host}><td className="mono">{host.host}</td><td>{hostLabels[host.state]}</td><td className="faint">{hostNote(host)}</td></tr>)}</tbody>
        </table>
      </div>
      {value.payoutConfirmation
        ? (
          <p className="notice">
            Revision {value.payoutConfirmation.revision} changes the payout address. It waits until every host lists <code>{value.payoutConfirmation.token}</code>, until {shortDate(value.payoutConfirmation.expiresAt)}.
            {' '}Confirmed on {value.payoutConfirmation.hosts.filter(host => host.confirmed).length} of {value.payoutConfirmation.hosts.length} hosts.
          </p>
        )
        : null}
      {value.notices.filter(notice => notice.code !== 'payout_change_waiting').map(notice => <p key={`${notice.code}:${notice.host ?? ''}`} className="notice">{notice.message}</p>)}
      <ErrorNotice error={error} />
      <div className="row">
        <button
          type="button"
          className="button button-small"
          disabled={busy || !api}
          onClick={async () => {
            setBusy(true);
            setError(undefined);
            try {
              setStatus(await api!.verify(detail));
            }
            catch (caught) {
              setError(caught instanceof Error ? caught : new Error(String(caught)));
            }
            finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Checking…' : 'Check now'}
        </button>
      </div>
    </div>
  );
};

/** `/console/services/<id>`: one service's state, earnings, status, stats, revisions, and config. */
export const ServicePage = ({ id }: { readonly id: string }) => {
  const { api, settings } = useConsole();
  const { data, error, reload } = useConsoleData(async consoleApi => {
    const [detail, revisions, earnings, list] = await Promise.all([consoleApi.service(id), consoleApi.revisions(id), consoleApi.earnings(id), consoleApi.services()]);
    const status = await consoleApi.status(detail);

    return { detail, revisions, earnings, status, title: list.find(service => service.id === id)?.title ?? id };
  }, [id]);
  const stats = sampleServiceStats(id);
  const docs = settings.agentDocsMocked
    ? { llms: `/discover/${id}/llms.txt`, skill: `/discover/${id}/skill.md`, openapi: `/discover/${id}/openapi.json` }
    : { llms: `${settings.apiUrl}/v1/services/${id}/llms.txt`, skill: `${settings.apiUrl}/v1/services/${id}/skill.md`, openapi: `${settings.apiUrl}/v1/services/${id}/openapi.json` };

  if (error)
    return <><ConsoleHeading title={id} /><ErrorNotice error={error} /></>;
  if (!data)
    return <><ConsoleHeading title={id} /><p className="faint">Loading…</p></>;
  const { detail, revisions, earnings, status, title } = data;

  return (
    <>
      <nav className="breadcrumb section" aria-label="Breadcrumb"><Link href="/console/services">Services</Link><span>/</span><span className="mono">{id}</span></nav>
      <ConsoleHeading title={title}><span className={detail.state === 'live' ? 'badge badge-mint' : 'badge'}>{detail.state}</span></ConsoleHeading>
      <p className="muted">Revision {detail.revision} · updated {shortDate(detail.updatedAt)} · pay URL <code>{settings.payUrl}/service/{id}</code></p>

      <section className="section">
        <h2>Earnings</h2>
        <div className="stats mt-8">
          <StatTile label="Earned" value={displayUsd(earnings.earned.total)} note={`${earnings.calls.toLocaleString('en-US')} paid calls`} />
          <StatTile label="Pending payout" value={displayUsd(earnings.pending)} note={`Next payout ${shortDate(earnings.nextPayoutDate)}`} />
          <StatTile label="Paid out" value={displayUsd(earnings.paidOut)} />
          <StatTile label="Platform fee" value={displayUsd(earnings.fee)} />
        </div>
        <div className="table-wrap mt-8">
          <table className="table">
            <thead><tr><th>Payment method</th><th className="num">Earned</th></tr></thead>
            <tbody>
              {Object.entries(earnings.earned.byRail).map(([rail, amount]) => (
                <tr key={rail}><td>{methodInfo[rail as keyof typeof methodInfo]?.title ?? rail}</td><td className="num">{displayUsd(amount ?? '0')}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section grid grid-2">
        <OwnershipCard detail={detail} initial={status} />
        <div className="card stack">
          <div className="row"><h3>Last 30 days</h3><SampleBadge /></div>
          <div className="stats stats-4">
            <div><div className="label">Calls</div><div className="value-small">{compactCount(stats.calls30d)}</div></div>
            <div><div className="label">Success</div><div className="value-small">{percent(stats.successRate)}</div></div>
            <div><div className="label">Median</div><div className="value-small">{latency(stats.p50Ms)}</div></div>
            <div><div className="label">p95</div><div className="value-small">{latency(stats.p95Ms)}</div></div>
          </div>
          <h3 className="mt-8">For agents</h3>
          <div className="row">
            <a className="mono" href={`/discover/${id}`}>Public page</a>
            <a className="mono" href={docs.llms}>llms.txt</a>
            <a className="mono" href={docs.skill}>skill.md</a>
            <a className="mono" href={docs.openapi}>openapi.json</a>
          </div>
        </div>
      </section>

      <section className="section">
        <h2>Revisions</h2>
        <p className="muted mt-8">Each submit makes a revision. Rolling back makes an older one active again.</p>
        <div className="table-wrap mt-8">
          <table className="table">
            <thead><tr><th className="num">Revision</th><th>Created</th><th>Format</th><th /></tr></thead>
            <tbody>
              {revisions.map(revision => (
                <tr key={revision.number}>
                  <td className="num">{revision.number}</td>
                  <td>{shortDate(revision.createdAt)}</td>
                  <td className="mono faint">{revision.mediaType}</td>
                  <td>
                    {revision.active
                      ? <span className="badge badge-mint">Active</span>
                      : (
                        <ConfirmButton
                          label="Roll back to this"
                          confirm={`Make revision ${revision.number} active`}
                          onConfirm={async () => {
                            await api!.rollback(id, revision.number);
                            reload();
                          }}
                        />
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section grid grid-2">
        <div className="card stack">
          <h3>Secrets</h3>
          <p className="muted">Names only: values are sealed and never shown again. Rotate one with <code>PUT /v1/services/{id}/secrets/&lt;name&gt;</code>.</p>
          {detail.secrets.length === 0 ? <span className="faint">None</span> : detail.secrets.map(secret => <span key={secret.name} className="mono">{secret.name} <span className="faint">· {shortDate(secret.updatedAt)}</span></span>)}
        </div>
        <details className="card">
          <summary><strong>Config of revision {detail.revision}</strong></summary>
          <pre className="code mt-8">{detail.config.text}</pre>
        </details>
      </section>
    </>
  );
};
