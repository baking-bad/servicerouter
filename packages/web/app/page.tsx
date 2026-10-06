import type { Metadata } from 'next';

import { buyerSkillPath, sellerSkillPath } from '../src/agents/guide';
import { platformPrompt, sellerPrompt } from '../src/agents/prompts';
import { listCatalog } from '../src/api/catalog';
import { CopyText } from '../src/components/CopyText';
import { JsonLd } from '../src/components/JsonLd';
import { SampleBadge } from '../src/components/SampleBadge';
import { ServiceCard } from '../src/components/ServiceCard';
import { readSettings } from '../src/config';
import { buyerSteps, methodInfo, pitch, sellerSteps, tagline } from '../src/content';
import { requestNonce } from '../src/nonce';
import { websiteJsonLd } from '../src/seo/jsonld';

export const metadata: Metadata = {
  alternates: { canonical: '/', types: { 'text/markdown': '/index.md' } },
};

const LandingPage = async () => {
  const settings = readSettings();
  const nonce = await requestNonce();
  const popular = await listCatalog(settings, { sort: 'popular', limit: 6 });
  const titles = new Map(popular.value.categories.map(category => [category.id, category.title]));

  return (
    <div className="container">
      <JsonLd data={websiteJsonLd(settings)} nonce={nonce} />
      <section className="hero">
        <div>
          <span className="eyebrow">For AI agents and the APIs they call</span>
          <h1>{tagline}</h1>
          <p className="lead">{pitch}</p>
          <div className="hero-actions">
            <a className="button button-primary" href="/discover">Discover services</a>
            <a className="button" href="/agents">Connect your agent</a>
            <a className="button" href="#sell">Sell your API</a>
          </div>
        </div>
        <pre className="code code-wrap" aria-label="A call through Service Router">
          <span className="prompt">$ </span>curl {new URL(settings.payUrl).host}/service/skycast-weather/current/oslo{'\n'}
          <span className="warn">402 Payment Required</span>  credits · x402 · MPP{'\n\n'}
          <span className="prompt">$ </span>curl … -H &quot;Authorization: Bearer sr_live_…&quot;{'\n'}
          <span className="ok">200 OK</span>{'\n'}
          Servicerouter-Receipt: id=&quot;pay_…&quot;, amount=&quot;0.001&quot;
        </pre>
      </section>

      <section className="section">
        <div className="section-head"><h2>Give this to your agent</h2></div>
        <CopyText text={platformPrompt(settings)} />
        <p className="muted mt-8">
          It reads <a href="/llms.txt" className="mono">/llms.txt</a>, signs up with your permission, and calls with a payment key that has the limits you set.
        </p>
      </section>

      <section className="section grid grid-2">
        <div className="card stack">
          <span className="eyebrow">For buyers and their agents</span>
          <ol className="stack steps plain-list">
            {buyerSteps.map(step => <li key={step.title} className="step"><h3>{step.title}</h3><p className="muted">{step.text}</p></li>)}
          </ol>
          <a href={buyerSkillPath} className="mono faint">Buyer skill →</a>
        </div>
        <div className="card stack" id="sell">
          <span className="eyebrow">For sellers</span>
          <ol className="stack steps plain-list">
            {sellerSteps.map(step => <li key={step.title} className="step"><h3>{step.title}</h3><p className="muted">{step.text}</p></li>)}
          </ol>
          <CopyText text={sellerPrompt(settings)} />
          <a href={sellerSkillPath} className="mono faint">Seller skill →</a>
        </div>
      </section>

      <section className="section">
        <div className="section-head"><h2>Three ways to pay</h2></div>
        <div className="grid grid-3">
          {(['credits', 'x402', 'mpp'] as const).map(method => (
            <div key={method} className="card method-card">
              <h3>{methodInfo[method].title}</h3>
              <p className="muted">{methodInfo[method].text}</p>
              <p className="faint mt-8">{methodInfo[method].networks}</p>
            </div>
          ))}
        </div>
        <p className="muted mt-16">Whatever the method, only successful answers are charged.</p>
      </section>

      <section className="section">
        <div className="section-head">
          <div className="row"><h2>Popular services</h2><SampleBadge sample={popular.sample} /></div>
          <a href="/discover" className="muted">Every service →</a>
        </div>
        <div className="grid grid-3">
          {popular.value.services.map(item => <ServiceCard key={item.id} item={item} categoryTitle={titles.get(item.category)} />)}
        </div>
      </section>
    </div>
  );
};

export default LandingPage;
