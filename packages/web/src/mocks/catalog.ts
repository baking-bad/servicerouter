import type { CatalogItem, CatalogRoute, CatalogService, CatalogStats, PaymentMethod } from '../api/types';
import { formatMicroUsd, parseUsd } from '../money';

// Sample data for the catalog until step 13 ships GET /v1/catalog (WB-10). Every service here is
// invented: no real company, product, or API. The shapes are CI-5's.

export const sampleCategoryTitles: ReadonlyMap<string, string> = new Map([
  ['ai', 'AI'],
  ['ai/image-generation', 'Image generation'],
  ['ai/speech', 'Speech'],
  ['ai/translation', 'Translation'],
  ['blockchain', 'Blockchain'],
  ['blockchain/rpc', 'Node RPC'],
  ['data', 'Data'],
  ['data/companies', 'Company data'],
  ['data/geo', 'Geocoding'],
  ['finance', 'Finance'],
  ['finance/fx', 'Currency exchange'],
  ['finance/market-data', 'Market data'],
  ['search', 'Search'],
  ['weather', 'Weather'],
]);

interface SampleRoute {
  readonly key: string;
  readonly method: string;
  readonly path: string;
  readonly summary: string;
  readonly price: string;
  readonly calls30d: number;
  readonly successRate: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
}

interface SampleService {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly description: string;
  readonly category: string;
  readonly tags: readonly string[];
  readonly homepage: string;
  readonly updatedAt: string;
  readonly routes: readonly SampleRoute[];
}

// Payment methods as the platform's minimum prices would offer them: credits for every price, x402 from
// $0.001, MPP from $0.002 (PR-3). The sample shows the filter at work.
const methodsFor = (price: string): readonly PaymentMethod[] => {
  const micro = parseUsd(price) ?? 0n;

  return ['credits', ...(micro >= 1_000n ? ['x402' as const] : []), ...(micro >= 2_000n ? ['mpp' as const] : [])];
};

const samples: readonly SampleService[] = [
  {
    id: 'skycast-weather', title: 'Skycast Weather', category: 'weather', tags: ['forecast', 'geo', 'climate'],
    summary: 'Current conditions and 14-day forecasts for any city',
    description: 'Current weather and hourly or daily forecasts for any city or coordinate, with temperature, wind, precipitation, and air quality.',
    homepage: 'https://skycast.example.com', updatedAt: '2026-10-06T19:50:00+08:00',
    routes: [
      { key: 'getCurrent', method: 'GET', path: '/current/{city}', summary: 'Current conditions', price: '0.001', calls30d: 182_400, successRate: 0.998, p50Ms: 84, p95Ms: 210 },
      { key: 'getForecast', method: 'GET', path: '/forecast/{city}', summary: '14-day forecast', price: '0.002', calls30d: 61_250, successRate: 0.997, p50Ms: 120, p95Ms: 340 },
    ],
  },
  {
    id: 'ticker-quotes', title: 'Ticker Quotes', category: 'finance/market-data', tags: ['stocks', 'quotes', 'ohlc'],
    summary: 'Real-time stock quotes and daily price history',
    description: 'Last price, bid, ask, and volume for listed equities, and daily open-high-low-close history going back 20 years.',
    homepage: 'https://ticker-quotes.example.com', updatedAt: '2026-10-06T19:50:00+08:00',
    routes: [
      { key: 'getQuote', method: 'GET', path: '/quote/{symbol}', summary: 'Latest quote', price: '0.0005', calls30d: 412_900, successRate: 0.999, p50Ms: 42, p95Ms: 118 },
      { key: 'getHistory', method: 'GET', path: '/history/{symbol}', summary: 'Daily OHLC history', price: '0.002', calls30d: 38_700, successRate: 0.996, p50Ms: 160, p95Ms: 480 },
    ],
  },
  {
    id: 'crypto-prices', title: 'Crypto Prices', category: 'finance/market-data', tags: ['crypto', 'prices', 'tokens'],
    summary: 'Spot prices for 5,000 tokens, aggregated across exchanges',
    description: 'Volume-weighted spot prices for thousands of tokens, updated every few seconds, with 24-hour change and volume.',
    homepage: 'https://crypto-prices.example.com', updatedAt: '2026-10-06T19:50:00+08:00',
    routes: [
      { key: 'getPrice', method: 'GET', path: '/price/{asset}', summary: 'Spot price', price: '0.0001', calls30d: 906_300, successRate: 0.995, p50Ms: 35, p95Ms: 95 },
    ],
  },
  {
    id: 'fx-rates', title: 'FX Rates', category: 'finance/fx', tags: ['currency', 'exchange-rates', 'conversion'],
    summary: 'Exchange rates for 170 currencies, and conversion',
    description: 'Mid-market exchange rates for 170 currencies, refreshed every minute, and amount conversion between any two of them.',
    homepage: 'https://fx-rates.example.com', updatedAt: '2026-10-06T19:50:00+08:00',
    routes: [
      { key: 'getRates', method: 'GET', path: '/rates/{base}', summary: 'Every rate against a base currency', price: '0.0002', calls30d: 74_100, successRate: 0.999, p50Ms: 38, p95Ms: 90 },
      { key: 'convert', method: 'GET', path: '/convert', summary: 'Convert an amount', price: '0.0002', calls30d: 52_800, successRate: 0.999, p50Ms: 40, p95Ms: 96 },
    ],
  },
  {
    id: 'pixel-forge', title: 'Pixel Forge', category: 'ai/image-generation', tags: ['images', 'diffusion', 'upscale'],
    summary: 'Text-to-image generation and 4x upscaling',
    description: 'Generates images from a text prompt at up to 2048 px, and upscales existing images four times. Returns PNG or WebP.',
    homepage: 'https://pixel-forge.example.com', updatedAt: '2026-10-06T19:50:00+08:00',
    routes: [
      { key: 'createImage', method: 'POST', path: '/images', summary: 'Generate an image', price: '0.04', calls30d: 21_600, successRate: 0.981, p50Ms: 6_200, p95Ms: 11_800 },
      { key: 'upscaleImage', method: 'POST', path: '/images/upscale', summary: 'Upscale an image 4x', price: '0.02', calls30d: 8_900, successRate: 0.986, p50Ms: 3_100, p95Ms: 6_400 },
    ],
  },
  {
    id: 'voice-scribe', title: 'Voice Scribe', category: 'ai/speech', tags: ['transcription', 'speech-to-text', 'tts'],
    summary: 'Speech to text in 40 languages, and text to speech',
    description: 'Transcribes audio files with timestamps and speaker labels, and turns text into natural speech in 12 voices.',
    homepage: 'https://voice-scribe.example.com', updatedAt: '2026-10-06T19:50:00+08:00',
    routes: [
      { key: 'transcribe', method: 'POST', path: '/transcribe', summary: 'Transcribe up to 10 minutes of audio', price: '0.01', calls30d: 15_300, successRate: 0.989, p50Ms: 2_400, p95Ms: 7_900 },
      { key: 'speak', method: 'POST', path: '/speak', summary: 'Text to speech', price: '0.005', calls30d: 9_700, successRate: 0.993, p50Ms: 900, p95Ms: 2_200 },
    ],
  },
  {
    id: 'lingua-translate', title: 'Lingua Translate', category: 'ai/translation', tags: ['translation', 'languages', 'localization'],
    summary: 'Machine translation between 90 languages',
    description: 'Translates text and simple HTML between 90 languages, keeps formatting, and detects the source language.',
    homepage: 'https://lingua.example.com', updatedAt: '2026-10-06T19:50:00+08:00',
    routes: [
      { key: 'translate', method: 'POST', path: '/translate', summary: 'Translate up to 5,000 characters', price: '0.001', calls30d: 67_800, successRate: 0.997, p50Ms: 310, p95Ms: 820 },
    ],
  },
  {
    id: 'chain-rpc', title: 'Chain RPC Gateway', category: 'blockchain/rpc', tags: ['rpc', 'json-rpc', 'ethereum', 'base', 'solana'],
    summary: 'JSON-RPC for Ethereum, Base, and Solana, paid per call',
    description: 'Full-node JSON-RPC for Ethereum, Base, and Solana mainnets. Send one JSON-RPC request per HTTP call.',
    homepage: 'https://chain-rpc.example.com', updatedAt: '2026-10-06T19:50:00+08:00',
    routes: [
      { key: 'ethRpc', method: 'POST', path: '/eth', summary: 'Ethereum JSON-RPC', price: '0.0005', calls30d: 538_000, successRate: 0.998, p50Ms: 48, p95Ms: 160 },
      { key: 'baseRpc', method: 'POST', path: '/base', summary: 'Base JSON-RPC', price: '0.0005', calls30d: 297_400, successRate: 0.998, p50Ms: 44, p95Ms: 150 },
      { key: 'solRpc', method: 'POST', path: '/sol', summary: 'Solana JSON-RPC', price: '0.0005', calls30d: 351_900, successRate: 0.996, p50Ms: 55, p95Ms: 190 },
    ],
  },
  {
    id: 'block-explorer', title: 'Block Explorer API', category: 'blockchain', tags: ['bitcoin', 'explorer', 'utxo'],
    summary: 'Bitcoin addresses, transactions, and blocks',
    description: 'Balances and history for Bitcoin addresses, transaction details, blocks, UTXOs, and fee estimates.',
    homepage: 'https://explorer-api.example.com', updatedAt: '2026-10-06T19:50:00+08:00',
    routes: [
      { key: 'getAddress', method: 'GET', path: '/btc/address/{address}', summary: 'An address and its history', price: '0.001', calls30d: 46_200, successRate: 0.994, p50Ms: 210, p95Ms: 640 },
      { key: 'getTransaction', method: 'GET', path: '/btc/tx/{txid}', summary: 'A transaction', price: '0.001', calls30d: 33_900, successRate: 0.997, p50Ms: 130, p95Ms: 380 },
    ],
  },
  {
    id: 'geo-lookup', title: 'Geo Lookup', category: 'data/geo', tags: ['geocoding', 'addresses', 'maps'],
    summary: 'Addresses to coordinates and back',
    description: 'Forward and reverse geocoding worldwide, with structured address parts and a confidence score.',
    homepage: 'https://geo-lookup.example.com', updatedAt: '2026-10-06T19:50:00+08:00',
    routes: [
      { key: 'geocode', method: 'GET', path: '/geocode', summary: 'An address to coordinates', price: '0.0005', calls30d: 88_400, successRate: 0.991, p50Ms: 95, p95Ms: 260 },
      { key: 'reverse', method: 'GET', path: '/reverse', summary: 'Coordinates to an address', price: '0.0005', calls30d: 41_700, successRate: 0.993, p50Ms: 90, p95Ms: 240 },
    ],
  },
  {
    id: 'company-facts', title: 'Company Facts', category: 'data/companies', tags: ['companies', 'enrichment', 'b2b'],
    summary: 'Firmographics for any company domain',
    description: 'Name, industry, headcount range, location, and social profiles for a company, by its web domain.',
    homepage: 'https://company-facts.example.com', updatedAt: '2026-10-06T19:50:00+08:00',
    routes: [
      { key: 'getCompany', method: 'GET', path: '/companies/{domain}', summary: 'A company by domain', price: '0.01', calls30d: 12_100, successRate: 0.962, p50Ms: 380, p95Ms: 1_400 },
    ],
  },
  {
    id: 'web-search-lite', title: 'Web Search Lite', category: 'search', tags: ['search', 'web', 'snippets'],
    summary: 'Web search results with titles, links, and snippets',
    description: 'Ten organic web results per query, with titles, links, and snippets, in 30 languages. No ads.',
    homepage: 'https://search-lite.example.com', updatedAt: '2026-10-06T19:50:00+08:00',
    routes: [
      { key: 'search', method: 'GET', path: '/search', summary: 'Search the web', price: '0.003', calls30d: 129_500, successRate: 0.985, p50Ms: 640, p95Ms: 1_900 },
    ],
  },
  {
    id: 'news-digest', title: 'News Digest', category: 'search', tags: ['news', 'headlines', 'summaries'],
    summary: 'Headlines by topic, with one-paragraph summaries',
    description: 'Current headlines by topic or keyword from thousands of sources, each with a one-paragraph summary and its source link.',
    homepage: 'https://news-digest.example.com', updatedAt: '2026-10-06T19:50:00+08:00',
    routes: [
      { key: 'getHeadlines', method: 'GET', path: '/headlines', summary: 'Headlines for a topic', price: '0.002', calls30d: 27_300, successRate: 0.99, p50Ms: 450, p95Ms: 1_100 },
    ],
  },
];

const statsOf = (routes: readonly SampleRoute[]): CatalogStats => {
  const calls = routes.reduce((sum, route) => sum + route.calls30d, 0);
  const weighted = (pick: (route: SampleRoute) => number) => routes.reduce((sum, route) => sum + pick(route) * route.calls30d, 0) / calls;

  return {
    calls30d: calls,
    successRate: Math.round(weighted(route => route.successRate) * 1_000) / 1_000,
    p50Ms: Math.round(weighted(route => route.p50Ms)),
    p95Ms: Math.max(...routes.map(route => route.p95Ms)),
  };
};

export interface SampleLinks {
  // Where a service's agent documents are: the website while they are sample data, AR1 otherwise
  readonly docsFor: (id: string) => CatalogService['docs'];
  readonly payUrlFor: (id: string) => string;
}

const toService = (sample: SampleService, links: SampleLinks): CatalogService => {
  const prices = sample.routes.map(route => parseUsd(route.price) ?? 0n);
  const methods = [...new Set(sample.routes.flatMap(route => methodsFor(route.price)))];

  return {
    id: sample.id,
    title: sample.title,
    summary: sample.summary,
    category: sample.category,
    tags: sample.tags,
    priceFrom: formatMicroUsd(prices.reduce((low, price) => price < low ? price : low)),
    currency: 'USD',
    methods: (['credits', 'x402', 'mpp'] as const).filter(method => methods.includes(method)),
    stats: statsOf(sample.routes),
    verified: true,
    updatedAt: sample.updatedAt,
    description: sample.description,
    links: { homepage: sample.homepage, docs: `${sample.homepage}/docs` },
    contact: { name: `${sample.title} support`, url: `${sample.homepage}/support` },
    routes: sample.routes.map((route): CatalogRoute => ({
      key: route.key,
      method: route.method,
      path: route.path,
      summary: route.summary,
      price: route.price,
      methods: methodsFor(route.price),
      stats: { calls30d: route.calls30d, successRate: route.successRate, p50Ms: route.p50Ms, p95Ms: route.p95Ms },
    })),
    docs: links.docsFor(sample.id),
    payUrl: links.payUrlFor(sample.id),
  };
};

/** Every sample service, in full (`GET /v1/catalog/{id}`'s shape). */
export const sampleServices = (links: SampleLinks): readonly CatalogService[] => samples.map(sample => toService(sample, links));

/** A service as a list item (`GET /v1/catalog`'s shape). */
export const toCatalogItem = ({ id, title, summary, category, tags, priceFrom, currency, methods, stats, verified, updatedAt }: CatalogService): CatalogItem =>
  ({ id, title, summary, category, tags, priceFrom, currency, methods, stats, verified, updatedAt });
