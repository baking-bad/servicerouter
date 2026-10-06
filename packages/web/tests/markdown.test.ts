import { describe, expect, it } from 'vitest';

import { agentDocsFor } from '../src/api/catalog';
import { queryCatalog } from '../src/catalog/query';
import { readSettings } from '../src/config';
import { sampleNotice } from '../src/content';
import { hasMarkdown, markdownRoute, markdownUrl, pageForMarkdownUrl, prefersMarkdown } from '../src/markdown/negotiate';
import { agentsMarkdown, discoverMarkdown, landingMarkdown, serviceMarkdown, topupMarkdown } from '../src/markdown/pages';
import { sampleCategoryTitles, sampleServices, toCatalogItem } from '../src/mocks/catalog';
import { sampleTopup } from '../src/mocks/topup';

const settings = readSettings({ SITE_URL: 'https://site.test', API_URL: 'https://api.test', PAY_URL: 'https://pay.test' });
const services = sampleServices({ docsFor: id => agentDocsFor(settings, id), payUrlFor: id => `${settings.payUrl}/service/${id}` });

describe('Markdown versions of the pages (WB-11)', () => {
  it.each([
    ['/index.md', '/'],
    ['/discover.md', '/discover'],
    ['/discover/chain-rpc.md', '/discover/chain-rpc'],
    ['/agents.md', '/agents'],
    ['/topup/abc123.md', '/topup/abc123'],
  ])('maps %s to the page %s', (url, page) => {
    expect(pageForMarkdownUrl(url)).toBe(page);
    expect(markdownUrl(page)).toBe(url);
    expect(hasMarkdown(page)).toBe(true);
  });

  it.each(['/.md', '/skills/servicerouter-buyer/SKILL.md', '/discover/chain-rpc/skill.md', '/console.md', '/discover/a/b.md', '/llms.txt'])('has no page for %s', url => {
    expect(pageForMarkdownUrl(url)).toBeUndefined();
  });

  it('renders under /md', () => {
    expect(markdownRoute('/')).toBe('/md');
    expect(markdownRoute('/discover/chain-rpc')).toBe('/md/discover/chain-rpc');
  });

  it.each([
    ['text/markdown', true],
    ['text/markdown, text/html;q=0.5', true],
    ['text/html, text/markdown;q=0.9', false],
    ['text/html,application/xhtml+xml,*/*;q=0.8', false],
    ['*/*', false],
    ['text/markdown;q=0', false],
    [null, false],
  ])('reads Accept: %s as Markdown: %s', (accept, expected) => {
    expect(prefersMarkdown(accept)).toBe(expected);
  });

  it('says so in every page with sample data', () => {
    const page = queryCatalog(services.map(toCatalogItem), sampleCategoryTitles, { sort: 'popular' });

    expect(landingMarkdown(settings, { services: page.services.slice(0, 3), sample: true })).toContain(sampleNotice);
    expect(discoverMarkdown(settings, page, { sort: 'popular' }, true)).toContain(sampleNotice);
    expect(serviceMarkdown(settings, services[0]!, true)).toContain(sampleNotice);
    expect(topupMarkdown(sampleTopup('t'), true)).toContain('Never send funds to this sample address');
    expect(serviceMarkdown(settings, services[0]!, false)).not.toContain(sampleNotice);
  });

  it('carries the page\'s content: the catalog with its filters, a service\'s routes and documents, and the agent resources', () => {
    const page = queryCatalog(services.map(toCatalogItem), sampleCategoryTitles, { category: 'finance', sort: 'price', limit: 2 });
    const discover = discoverMarkdown(settings, page, { category: 'finance', sort: 'price', limit: 2 }, true);
    const service = serviceMarkdown(settings, services.find(item => item.id === 'chain-rpc')!, true);

    expect(discover).toContain('Filtered by `category=finance&sort=price&limit=2`');
    expect(discover).toContain('[Crypto Prices](https://site.test/discover/crypto-prices.md)');
    expect(discover).toContain('[Next page](https://site.test/discover.md?category=finance&sort=price&limit=2&cursor=2)');
    expect(service).toContain('| `POST /eth` | Ethereum JSON-RPC | $0.0005 | Credits |');
    expect(service).toContain('[OpenAPI](https://site.test/discover/chain-rpc/openapi.json)');
    expect(agentsMarkdown(settings)).toContain('[llms.txt](https://site.test/llms.txt)');
  });
});
