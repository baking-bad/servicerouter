import { fixtureTime } from '@servicerouter/testing';

import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';

import { logoPaths, logoSvg, logoViewBox } from '../src/logo';
import { sampleTopup } from '../src/mocks/topup';
import { qrSvg } from '../src/qr';
import { jsonLdText, serviceJsonLd } from '../src/seo/jsonld';


describe('the logo (WB-9)', () => {

  it('draws the SVG favicon from those paths, in mint', () => {
    const svg = logoSvg();

    expect(svg).toContain('fill="#18D2A5"');
    for (const path of logoPaths)
      expect(svg).toContain(`<path d="${path}"/>`);
  });
});

describe('the top-up QR code (WB-3)', () => {
  it('encodes the deposit address, and nothing else', async () => {
    const { address } = sampleTopup('t');
    const code = QRCode.create(address, { errorCorrectionLevel: 'M' });

    // Byte segments carry bytes; numeric and alphanumeric ones carry text
    const data = code.segments.map(({ data: part }) => typeof part === 'string' ? part : Buffer.from(part as unknown as Uint8Array).toString('utf8'));

    expect(data.join('')).toBe(address);
    expect(await qrSvg(address)).toMatch(/^<svg[\s\S]*<path[\s\S]*<\/svg>\s*$/);
  });
});

describe('JSON-LD (WB-11)', () => {
  it('can\'t close its script tag', () => {
    expect(jsonLdText({ name: '</script><script>alert(1)</script>' })).not.toContain('</script>');
  });

  it('describes a service as a WebAPI with an offer per route', () => {
    const data = serviceJsonLd({ siteUrl: 'https://site.test', apiUrl: 'https://api.test', payUrl: 'https://pay.test', mocks: new Set() }, {
      id: 'x', title: 'X', summary: 'S', category: 'weather', tags: ['a'], priceFrom: '0.001', currency: 'USD', methods: ['credits'],
      stats: { calls30d: 1, successRate: 1, p50Ms: 1, p95Ms: 1 }, verified: true, updatedAt: fixtureTime(0, 6, 0, 0, 0, 0), description: 'D', links: {},
      contact: { name: 'X support' }, routes: [{ key: 'k', method: 'GET', path: '/a', summary: 'A', price: '0.001', methods: ['credits'], stats: { calls30d: 1, successRate: 1, p50Ms: 1, p95Ms: 1 } }],
      docs: { openapi: 'https://site.test/o', llms: 'https://site.test/l', skill: 'https://site.test/s' }, payUrl: 'https://pay.test/service/x',
    });

    expect(data).toMatchObject({ '@type': 'WebAPI', url: 'https://site.test/discover/x', offers: [{ '@type': 'Offer', price: '0.001', priceCurrency: 'USD', url: 'https://pay.test/service/x/a' }] });
  });
});
