import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { servicePrompt } from '../../../src/agents/prompts';
import { getCatalogService } from '../../../src/api/catalog';
import { CopyText } from '../../../src/components/CopyText';
import { JsonLd } from '../../../src/components/JsonLd';
import { MethodBadges } from '../../../src/components/MethodBadges';
import { SampleBadge } from '../../../src/components/SampleBadge';
import { readSettings } from '../../../src/config';
import { compactCount, latency, percent, shortDate } from '../../../src/format';
import { displayUsd } from '../../../src/money';
import { requestNonce } from '../../../src/nonce';
import { serviceJsonLd } from '../../../src/seo/jsonld';

interface ServiceProps {
  readonly params: Promise<{ readonly id: string }>;
}

export const generateMetadata = async ({ params }: ServiceProps): Promise<Metadata> => {
  const { id } = await params;
  const found = await getCatalogService(readSettings(), id);
  if (!found)
    return { title: 'Not found' };

  return {
    title: found.value.title,
    description: found.value.summary,
    alternates: { canonical: `/discover/${id}`, types: { 'text/markdown': `/discover/${id}.md` } },
    openGraph: { title: found.value.title, description: found.value.summary },
  };
};

const ServicePage = async ({ params }: ServiceProps) => {
  const { id } = await params;
  const settings = readSettings();
  const nonce = await requestNonce();
  const found = await getCatalogService(settings, id);
  if (!found)
    notFound();
  const { value: service, sample } = found;
  const example = service.routes[0];

  return (
    <div className="container">
      <JsonLd data={serviceJsonLd(settings, service)} nonce={nonce} />
      <section className="section stack">
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <a href="/discover">Discover</a><span>/</span><a href={`/discover?category=${service.category}`}>{service.category}</a>
        </nav>
        <div className="row"><h1>{service.title}</h1><SampleBadge sample={sample} /></div>
        <p className="lead">{service.summary}</p>
        <div className="row"><MethodBadges methods={service.methods} />{service.verified ? <span className="badge">Verified</span> : <span className="badge">Unverified</span>}</div>
      </section>

      <section className="section stats">
        <div className="card stat"><div className="label">Price from</div><div className="value">{displayUsd(service.priceFrom)}</div></div>
        <div className="card stat"><div className="label">Calls, 30 days</div><div className="value">{compactCount(service.stats.calls30d)}</div></div>
        <div className="card stat"><div className="label">Success</div><div className="value">{percent(service.stats.successRate)}</div></div>
        <div className="card stat"><div className="label">Median latency</div><div className="value">{latency(service.stats.p50Ms)}</div></div>
        <div className="card stat"><div className="label">p95 latency</div><div className="value">{latency(service.stats.p95Ms)}</div></div>
      </section>

      <section className="section split">
        <div className="stack">
          <h2>Routes</h2>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Route</th><th className="num">Price</th><th>Pay with</th><th className="num">Calls</th><th className="num">Success</th></tr></thead>
              <tbody>
                {service.routes.map(route => (
                  <tr key={route.key}>
                    <td><code>{`${route.method} ${route.path}`}</code><div className="muted">{route.summary}</div></td>
                    <td className="num">{displayUsd(route.price)}</td>
                    <td><MethodBadges methods={route.methods} /></td>
                    <td className="num">{compactCount(route.stats.calls30d)}</td>
                    <td className="num">{percent(route.stats.successRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2 className="mt-16">About</h2>
          <p className="muted pre-line">{service.description}</p>
          {example
            ? (
              <>
                <h2 className="mt-16">Call it</h2>
                <pre className="code">{`curl -X ${example.method} ${service.payUrl}${example.path.replace(/\{([^}]+)\}/g, '<$1>')} \\\n  -H "Authorization: Bearer $SERVICEROUTER_PAYMENT_KEY"`}</pre>
                <p className="muted">No payment key? The <code>402</code> answer also lists x402 and MPP options, no account needed.</p>
              </>
            )
            : null}
        </div>

        <aside className="stack">
          <div className="card stack">
            <h3>Give this to your agent</h3>
            <CopyText text={servicePrompt({ title: service.title, llms: service.docs.llms })} />
          </div>
          <div className="card stack">
            <h3>Agent documents</h3>
            <a className="mono" href={service.docs.llms}>llms.txt</a>
            <a className="mono" href={service.docs.skill}>skill.md</a>
            <a className="mono" href={service.docs.openapi}>openapi.json</a>
            <a className="mono faint" href={`/discover/${service.id}.md`}>This page as Markdown</a>
          </div>
          <div className="card stack">
            <h3>Links</h3>
            {service.links.homepage ? <a href={service.links.homepage} rel="nofollow noopener">Homepage</a> : null}
            {service.links.docs ? <a href={service.links.docs} rel="nofollow noopener">Documentation</a> : null}
            {service.contact.url ? <a href={service.contact.url} rel="nofollow noopener">Support</a> : null}
            <span className="faint">Pay URL: <code>{service.payUrl}</code></span>
            <span className="faint">Updated {shortDate(service.updatedAt)}</span>
          </div>
        </aside>
      </section>
    </div>
  );
};

export default ServicePage;
