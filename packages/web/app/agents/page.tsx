import type { Metadata } from 'next';

import { buyerSkillPath, sellerSkillPath } from '../../src/agents/guide';
import { platformPrompt, sellerPrompt } from '../../src/agents/prompts';
import { CopyText } from '../../src/components/CopyText';
import { readSettings } from '../../src/config';
import { methodInfo } from '../../src/content';

export const metadata: Metadata = {
  title: 'For agents',
  description: 'What AI agents can read on Service Router: the platform guide, Agent Skills, Markdown pages, and a document set for every service.',
  alternates: { canonical: '/agents', types: { 'text/markdown': '/agents.md' } },
};

const resources = [
  { href: '/llms.txt', title: 'llms.txt', text: 'The platform guide: sign up, create a payment key with limits, top up, and call any service.' },
  { href: '/llms-full.txt', title: 'llms-full.txt', text: 'The guide, both skills, and the whole catalog in one file.' },
  { href: buyerSkillPath, title: 'Buyer skill', text: 'An Agent Skill: pay for API calls with credits, x402, or MPP, with plain curl.' },
  { href: sellerSkillPath, title: 'Seller skill', text: 'An Agent Skill: list an API, submit its config and keys, and track earnings.' },
] as const;

const AgentsPage = () => {
  const settings = readSettings();

  return (
    <div className="container">
      <section className="section stack">
        <span className="eyebrow">No SDK, no MCP server: plain HTTP and text</span>
        <h1>Service Router for agents</h1>
        <p className="lead">Everything here is written for agents to read. Give your agent one line, and it finds the guide, asks you before it signs up or spends, and pays per call with the limits you set.</p>
        <CopyText text={platformPrompt(settings)} />
      </section>

      <section className="section grid grid-2">
        {resources.map(resource => (
          <a key={resource.href} href={resource.href} className="card card-link stack">
            <h3 className="mono">{resource.title}</h3>
            <p className="muted">{resource.text}</p>
          </a>
        ))}
      </section>

      <section className="section grid grid-2">
        <div className="card stack">
          <h3>Every page in Markdown</h3>
          <p className="muted">Add <code>.md</code> to a page&apos;s URL, such as <a className="mono" href="/discover.md">/discover.md</a>, or ask for any page with <code>Accept: text/markdown</code>.</p>
        </div>
        <div className="card stack">
          <h3>A document set per service</h3>
          <p className="muted">Each service links its own <code>llms.txt</code>, Agent Skill, and OpenAPI document. The OpenAPI server is the service&apos;s pay URL, so an agent can use it as it is.</p>
        </div>
      </section>

      <section className="section">
        <div className="section-head"><h2>Paying</h2></div>
        <div className="grid grid-3">
          {(['credits', 'x402', 'mpp'] as const).map(method => (
            <div key={method} className="card stack">
              <h3>{methodInfo[method].title}</h3>
              <p className="muted">{methodInfo[method].text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section stack">
        <h2>Selling</h2>
        <p className="muted">Sellers use the same plain HTTP. Give your agent this, and it walks you through listing your API:</p>
        <CopyText text={sellerPrompt(settings)} />
      </section>
    </div>
  );
};

export default AgentsPage;
