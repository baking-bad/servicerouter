import { readFileSync, writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { ServiceId } from '@servicerouter/common';

import {
  compileServiceRuntime, generateServiceDocuments, parseServiceConfig, paymentMethodsFor, serviceDocumentsInputHash, type PlatformConfig,
  type ServiceDocumentsInput,
} from '../../src/index.js';
import { examplePlatform, exampleServiceConfig, preprodEnterpriseAddress } from '../fixtures.js';

const fixtures = new URL('./fixtures/', import.meta.url);
// UPDATE_FIXTURES=1 writes the fixtures again from the generator
const update = process.env['UPDATE_FIXTURES'] === '1';

// A seller's document with what must not reach agents: servers, security, callbacks, and security schemes
const sellerOpenApi = {
  openapi: '3.1.0',
  info: { title: 'Weather', version: '7.2.0' },
  servers: [{ url: 'https://internal-weather.example.net/v7' }],
  security: [{ sellerKey: [] }],
  paths: {
    '/weather/{city}': {
      parameters: [{ name: 'city', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        operationId: 'getWeather',
        summary: 'Current weather for a city',
        servers: [{ url: 'https://eu.internal-weather.example.net' }],
        security: [{ sellerKey: [] }],
        parameters: [{ name: 'units', in: 'query', schema: { type: 'string', enum: ['metric', 'imperial'] } }],
        responses: {
          200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Weather' }, example: { city: 'Oslo', celsius: 4 } } } },
        },
        callbacks: { done: { '{$request.body#/url}': { post: { responses: { 200: { description: 'OK' } } } } } },
      },
    },
    '/forecast/{city}': { get: { operationId: 'getForecast', description: '14-day forecast' } },
    '/admin/reset': { post: { operationId: 'adminReset' } },
  },
  components: {
    schemas: { Weather: { type: 'object', properties: { city: { type: 'string' }, celsius: { type: 'number' } } } },
    securitySchemes: { sellerKey: { type: 'apiKey', in: 'header', name: 'X-Seller-Key' } },
  },
};

const inputFor = (platform: PlatformConfig = examplePlatform): ServiceDocumentsInput => {
  const parsed = parseServiceConfig(exampleServiceConfig);
  if (!parsed.ok)
    throw new Error('The example config doesn\'t parse');
  const openapiDocuments = new Map([['https://api.example.com/openapi.json', sellerOpenApi]]);
  const compiled = compileServiceRuntime({
    serviceId: 'my-app' as ServiceId, revision: 3, state: 'live', config: parsed.parsed.config, openapiDocuments, platform,
  });
  if (!compiled.ok)
    throw new Error('The example config doesn\'t compile');

  return { config: parsed.parsed.config, openapiDocuments, runtime: compiled.runtime, platform };
};

describe('generated agent documents (AD-1, AD-2, AD-3, AD-6)', () => {
  const documents = generateServiceDocuments(inputFor());
  const openapi = JSON.parse(documents['openapi.json'].content) as Record<string, any>;

  it.each(['openapi.json', 'llms.txt', 'skill.md', 'bazaar.json'] as const)('makes %s byte-identical to its fixture, every time (AD-6)', kind => {
    const path = new URL(kind === 'llms.txt' ? 'llms.fixture' : kind === 'skill.md' ? 'skill.fixture' : kind, fixtures);
    if (update)
      writeFileSync(path, documents[kind].content);

    expect(documents[kind].content).toBe(readFileSync(path, 'utf8'));
    expect(generateServiceDocuments(inputFor())[kind]).toEqual(documents[kind]);
  });

  it('points servers[0] at the pay URL, prices each operation, and asks for the payment key as bearer (AD-1)', () => {
    expect(openapi['openapi']).toBe('3.1.0');
    expect(openapi['servers']).toEqual([{ url: 'https://pay.staging.servicerouter.ai/service/my-app', description: expect.any(String) }]);
    expect(openapi['security']).toEqual([{ paymentKey: [] }]);
    expect(openapi['components'].securitySchemes).toEqual({ paymentKey: expect.objectContaining({ type: 'http', scheme: 'bearer' }) });
    expect(openapi['paths']['/weather/{city}'].get['x-payment-info']).toEqual({ price: '0.01', currency: 'USD', methods: ['credits', 'x402', 'mpp'] });
    expect(openapi['paths']['/forecast/{city}'].get['x-payment-info']).toEqual({ price: '0.001', currency: 'USD', methods: ['credits', 'x402', 'mpp'] });
    expect(openapi['paths']['/upload'].post['x-payment-info'].price).toBe('0.01');
  });

  it('keeps the seller\'s operations, parameters, and schemas, and leaves out disabled routes (AD-1)', () => {
    const weather = openapi['paths']['/weather/{city}'].get;

    expect(weather.parameters).toEqual([
      { name: 'city', in: 'path', required: true, schema: { type: 'string' } },
      { name: 'units', in: 'query', schema: { type: 'string', enum: ['metric', 'imperial'] } },
    ]);
    expect(openapi['components'].schemas.Weather).toEqual(sellerOpenApi.components.schemas.Weather);
    expect(openapi['paths']['/admin/reset']).toBeUndefined();
  });

  it('carries no upstream URL, no seller security scheme, and no credential name (AD-1)', () => {
    for (const kind of ['openapi.json', 'llms.txt', 'skill.md', 'bazaar.json'] as const) {
      const content = documents[kind].content;
      expect(content).not.toContain('internal-weather.example.net');
      expect(content).not.toContain('api.example.com');
      expect(content).not.toContain('files.example.com');
      expect(content).not.toContain('X-Seller-Key');
      expect(content).not.toContain('sellerKey');
      expect(content).not.toContain('weather-key');
      expect(content).not.toContain('X-Api-Key');
      expect(content).not.toContain(preprodEnterpriseAddress);
    }
  });

  it('explains how to pay, credits first, with the routes and their prices (AD-2)', () => {
    const llms = documents['llms.txt'].content;
    const skill = documents['skill.md'].content;

    expect(llms).toMatch(/^# My App\n\n> Weather forecasts for any city/);
    expect(llms.indexOf('**Credits (default).**')).toBeLessThan(llms.indexOf('**x402.**'));
    expect(llms).toContain('| `GET /weather/{city}` | Current weather for a city | $0.01 | credits (payment key), x402, MPP |');
    expect(llms).toContain('curl -X GET "https://pay.staging.servicerouter.ai/service/my-app/weather/<city>"');
    expect(skill).toMatch(/^---\nname: my-app\ndescription: "/);
    expect(skill).toContain('Base URL: `https://pay.staging.servicerouter.ai/service/my-app`');
  });

  it('describes each paid operation for the x402 Bazaar: input, output schema, and example (AD-3)', () => {
    const bazaar = JSON.parse(documents['bazaar.json'].content) as { operations: Record<string, unknown>[] };

    expect(bazaar.operations[0]).toEqual({
      resource: 'https://pay.staging.servicerouter.ai/service/my-app/weather/{city}',
      method: 'GET',
      description: 'Current weather for a city',
      input: {
        parameters: [
          { name: 'city', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'units', in: 'query', required: false, schema: { type: 'string', enum: ['metric', 'imperial'] } },
        ],
        body: null,
      },
      output: { contentType: 'application/json', schema: { $ref: '#/components/schemas/Weather' } },
      example: { city: 'Oslo', celsius: 4 },
    });
  });

  it('makes the documents again when the platform changes what they say (AD-4)', () => {
    const moved = { ...examplePlatform, urls: { ...examplePlatform.urls, pay: 'https://pay.example.org' } };

    expect(serviceDocumentsInputHash(inputFor(moved))).not.toBe(serviceDocumentsInputHash(inputFor()));
    expect(serviceDocumentsInputHash(inputFor())).toBe(serviceDocumentsInputHash(inputFor()));
  });

  it('offers only the methods an asset\'s minimum price allows, and none for a free call', () => {
    const cardanoOnly = { ...examplePlatform, assets: examplePlatform.assets.map(asset => ({ ...asset, minPrice: 50_000n })) };

    expect(paymentMethodsFor(0n, examplePlatform)).toEqual([]);
    expect(paymentMethodsFor(1_000n, cardanoOnly)).toEqual(['credits']);
  });
});
