import { describe, expect, it } from 'vitest';

import { fullDocument } from '../src/agents/full';
import { platformGuide } from '../src/agents/guide';
import { platformPrompt, servicePrompt } from '../src/agents/prompts';
import { serviceLlms, serviceOpenApi, serviceSkill } from '../src/agents/serviceDocs';
import { platformSkills, skillDocument } from '../src/agents/skills';
import { agentDocsFor, listAllCatalog } from '../src/api/catalog';
import { readSettings } from '../src/config';
import { sampleServices } from '../src/mocks/catalog';

const settings = readSettings({ SITE_URL: 'https://site.test', API_URL: 'https://api.test', PAY_URL: 'https://pay.test' });
const services = sampleServices({ docsFor: id => agentDocsFor(settings, id), payUrlFor: id => `${settings.payUrl}/service/${id}` });
const service = services.find(candidate => candidate.id === 'skycast-weather')!;

// The Agent Skills frontmatter: `name` and `description`, between --- lines
const frontmatter = (text: string): Record<string, string> => {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match)
    throw new Error('No frontmatter');

  return Object.fromEntries(match[1]!.split('\n').map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]));
};

const links = (text: string): readonly string[] => [...text.matchAll(/\]\((https?:[^)\s]+)\)/g)].map(match => match[1]!);

describe('the platform guide at /llms.txt (AD-5, WB-11)', () => {
  const guide = platformGuide(settings);

  it('follows the llms.txt format: a title, a summary in a quote, then sections with links', () => {
    expect(guide.split('\n')[0]).toBe('# Service Router');
    expect(guide).toMatch(/^# Service Router\n\n> .+\n/);
    expect(guide).toContain('\n## Start with credits\n');
    expect(guide).toContain('\n## Optional\n');
    expect(links(guide).every(link => link.startsWith('https://site.test/'))).toBe(true);
  });

  it('walks an agent through AD-5\'s four steps, with the user\'s consent', () => {
    expect(guide).toContain('Ask your user before each of these steps');
    expect(guide).toContain('curl -X POST https://api.test/v1/accounts');
    expect(guide).toContain('chmod 600');
    expect(guide).toContain('can\'t be recovered');
    expect(guide).toContain('https://api.test/v1/keys');
    expect(guide).toContain('topupUrl');
  });

  it('links the catalog, both skills, the API, and the pay URL from the settings', () => {
    expect(links(guide)).toEqual(expect.arrayContaining([
      'https://site.test/discover.md',
      'https://site.test/skills/servicerouter-buyer/SKILL.md',
      'https://site.test/skills/servicerouter-seller/SKILL.md',
      'https://site.test/llms-full.txt',
    ]));
    expect(guide).toContain('https://pay.test/service/<service-id>/<path>');
  });

  it('says payment routing pays any API: x402 targets on Base and Solana, MPP targets on Tempo, and how to quote a link (RT-1, RT-19, T27, T29)', () => {
    const buyer = skillDocument(platformSkills.find(skill => skill.name === 'servicerouter-buyer')!, settings);

    for (const document of [guide, buyer]) {
      expect(document).toContain('https://pay.test/api.example.com/v1/pools');
      expect(document).toContain('x402 on Base or Solana, or MPP on Tempo');
      expect(document).toContain('USDM on Cardano');
      expect(document).toContain('https://pay.test/_/check?url=<link>');
    }
  });
});

describe('the platform Agent Skills (AD-5, AD-7, WB-11)', () => {
  it.each(platformSkills.map(skill => [skill.name, skill] as const))('%s has the frontmatter, and uses only plain HTTP with curl', (_name, skill) => {
    const document = skillDocument(skill, settings);
    const meta = frontmatter(document);

    expect(meta['name']).toBe(skill.name);
    expect(meta['name']).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(meta['description']!.length).toBeGreaterThan(40);
    expect(meta['description']!.length).toBeLessThanOrEqual(1024);
    expect(document).toContain('curl');
    expect(document).not.toMatch(/npm install|pip install|import .* from/);
  });

  it('teaches the seller AD-7: signup, a config, submitting it with its secrets, checking it, and ownership', () => {
    const seller = skillDocument(platformSkills.find(skill => skill.name === 'servicerouter-seller')!, settings);

    expect(seller).toContain('curl -s -X POST https://api.test/v1/accounts');
    expect(seller).toContain('servicerouter:\n  version: "1"');
    expect(seller).toContain('curl -s -X PUT https://api.test/v1/services/my-prices');
    expect(seller).toContain('{config: $config, secrets: {"upstream-key": $key}}');
    expect(seller).toContain('/.well-known/servicerouter.json');
    expect(seller).toContain('earnings');
  });

  it('tells the seller that a service is listed in the x402 Bazaar unless service.discoverable is false (P-4)', () => {
    const seller = skillDocument(platformSkills.find(skill => skill.name === 'servicerouter-seller')!, settings);

    expect(seller).toContain('  discoverable: true         # Listed in the x402 Bazaar. false keeps it out\n');
    expect(seller).toContain('`service.discoverable` (default `true`) lists each paid route in the x402 Bazaar');
    expect(seller).toContain('`discoverable: false` keeps the service out of it');
  });

  it('puts the guide, both skills, and the whole catalog in /llms-full.txt', async () => {
    const full = fullDocument(settings, await listAllCatalog(settings));

    expect(full).toContain(platformGuide(settings));
    for (const skill of platformSkills)
      expect(full).toContain(`name: ${skill.name}`);
    for (const item of services)
      expect(full).toContain(`https://site.test/discover/${item.id}.md`);
  });
});

describe('a service\'s agent documents (AD-1, AD-2)', () => {
  it('gives an OpenAPI 3.1 document whose server is the pay URL, with each price, and the payment key as its security', () => {
    const document = serviceOpenApi(service) as { servers: { url: string }[]; paths: Record<string, Record<string, Record<string, unknown>>>; components: { securitySchemes: Record<string, unknown> } };

    expect(document).toMatchObject({ openapi: '3.1.0', servers: [{ url: 'https://pay.test/service/skycast-weather' }], security: [{ paymentKey: [] }] });
    expect(document.components.securitySchemes['paymentKey']).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(document.paths['/current/{city}']!['get']).toMatchObject({
      operationId: 'getCurrent',
      'x-payment-info': { price: '0.001', currency: 'USD', methods: ['credits', 'x402'] },
      parameters: [{ name: 'city', in: 'path', required: true, schema: { type: 'string' } }],
    });
  });

  it('never names an upstream: every URL in the documents is the platform\'s', () => {
    const text = [JSON.stringify(serviceOpenApi(service)), serviceLlms(service, settings.siteUrl), serviceSkill(service, settings.siteUrl)].join('\n');
    const hosts = new Set([...text.matchAll(/https?:\/\/([a-z0-9.-]+)/g)].map(match => match[1]));

    expect([...hosts].sort()).toEqual(['pay.test', 'site.test']);
  });

  it('gives llms.txt and an Agent Skill with the routes, prices, and a call to copy', () => {
    const llms = serviceLlms(service, settings.siteUrl);
    const skill = serviceSkill(service, settings.siteUrl);

    expect(llms).toMatch(/^# Skycast Weather\n\n> /);
    expect(llms).toContain('| `GET /current/{city}` (Current conditions) | $0.001 |');
    expect(llms).toContain('curl -X GET https://pay.test/service/skycast-weather/current/<city>');
    expect(frontmatter(skill)['name']).toBe('skycast-weather');
    expect(skill).toContain('Base URL: `https://pay.test/service/skycast-weather`');
  });
});

describe('prompts for agents (WB-11)', () => {
  it('point at the guide or the service\'s instructions, and ask before spending', () => {
    expect(platformPrompt(settings)).toBe('Read https://site.test/llms.txt and set me up to pay for API calls through Service Router. Ask me before you sign up or spend anything.');
    expect(servicePrompt({ title: service.title, llms: service.docs.llms })).toContain('https://site.test/discover/skycast-weather/llms.txt');
    expect(servicePrompt({ title: service.title, llms: service.docs.llms })).toContain('Ask me before you spend anything.');
  });
});
