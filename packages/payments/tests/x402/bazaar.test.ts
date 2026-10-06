import { x402ResourceServer } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { bazaarResourceServerExtension, extractDiscoveryInfo, validateDiscoveryExtension, type DiscoveryExtension } from '@x402/extensions/bazaar';
import { describe, expect, it } from 'vitest';

import { createLogger } from '@servicerouter/common';
import type { BazaarMetadata } from '@servicerouter/core';

import { bazaarExtensionKey, createBazaarDeclarations } from '../../src/index.js';

const payUrl = 'https://pay.servicerouter.ai/service/weather';

const weather: BazaarMetadata = {
  resource: `${payUrl}/weather/{city}`,
  method: 'GET',
  description: 'Current weather for a city',
  input: {
    parameters: [
      { name: 'city', in: 'path', required: true, schema: { type: 'string', description: 'The city' } },
      { name: 'units', in: 'query', required: true, schema: { type: 'string', enum: ['metric', 'imperial'] } },
      { name: 'lang', in: 'query', required: true, schema: { type: 'string', format: 'bcp47' } },
    ],
    body: null,
  },
  output: {
    contentType: 'application/json',
    schema: { type: 'object', properties: { city: { type: 'string' }, celsius: { type: 'number' }, at: { type: 'string', format: 'date-time' } }, required: ['city'] },
  },
  example: { city: 'Oslo', celsius: 4 },
};

const declarations = (lines: Record<string, unknown>[] = []) => {
  const server = new x402ResourceServer([]).registerExtension(bazaarResourceServerExtension);
  const logger = createLogger({ level: 'info' }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });

  return createBazaarDeclarations(server, logger);
};

const bazaarOf = (extensions: Record<string, unknown> | undefined): DiscoveryExtension & { readonly routeTemplate?: string } =>
  extensions![bazaarExtensionKey] as DiscoveryExtension & { readonly routeTemplate?: string };

describe('the x402 Bazaar extension for a challenge (PR-7, AD-3)', () => {
  it('declares the method, the query and path parameters, the output\'s schema and example, under the operation\'s route template', () => {
    const extension = bazaarOf(declarations().extensionsFor(weather, `${payUrl}/weather/oslo`));

    expect(extension.info).toEqual({
      input: { type: 'http', method: 'GET', queryParams: { units: 'metric' }, pathParams: { city: 'oslo' } },
      output: { type: 'json', example: { city: 'Oslo', celsius: 4 } },
    });
    expect(extension.routeTemplate).toBe('/service/weather/weather/:city');
    const input = (extension.schema.properties.input as { properties: Record<string, unknown> }).properties;
    // `units` has a value to show, so it is required; `lang` has none, so it isn't
    expect(input['queryParams']).toEqual({
      type: 'object',
      properties: { units: { type: 'string', enum: ['metric', 'imperial'] }, lang: { type: 'string', format: 'bcp47' } },
      required: ['units'],
    });
    expect(input['pathParams']).toEqual({ type: 'object', properties: { city: { type: 'string', description: 'The city' } } });
    expect((extension.schema.properties as Record<string, { properties: Record<string, unknown> }>)['output']!.properties['example']).toEqual({
      type: 'object', properties: { city: { type: 'string' }, celsius: { type: 'number' }, at: { type: 'string', format: 'date-time' } }, required: ['city'],
    });
    expect(validateDiscoveryExtension(extension)).toEqual({ valid: true });
    expect(declarations().resourceOf(weather)).toEqual({ description: 'Current weather for a city', mimeType: 'application/json' });
  });

  it('is what a facilitator reads from the payment\'s echo: the operation, listed once under its route template', () => {
    const extensions = declarations().extensionsFor(weather, `${payUrl}/weather/bergen`);
    const payload = {
      x402Version: 2, resource: { url: `${payUrl}/weather/bergen`, description: weather.description }, accepted: {}, payload: {}, extensions,
    } as unknown as PaymentPayload;

    expect(extractDiscoveryInfo(payload, {} as PaymentRequirements)).toMatchObject({
      resourceUrl: 'https://pay.servicerouter.ai/service/weather/weather/:city',
      routeTemplate: '/service/weather/weather/:city',
      method: 'GET',
      description: 'Current weather for a city',
      discoveryInfo: { input: { pathParams: { city: 'bergen' } }, output: { example: { city: 'Oslo', celsius: 4 } } },
    });
  });

  it('declares a JSON body with its schema and example for POST', () => {
    const upload: BazaarMetadata = {
      resource: `${payUrl}/reports`,
      method: 'POST',
      description: 'Make a report',
      input: {
        parameters: [],
        body: { contentType: 'application/json', schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], example: { city: 'Oslo' } } },
      },
      output: null,
      example: null,
    };

    const extension = bazaarOf(declarations().extensionsFor(upload, `${payUrl}/reports`));

    expect(extension.info).toEqual({ input: { type: 'http', method: 'POST', bodyType: 'json', body: { city: 'Oslo' } } });
    expect(extension.routeTemplate).toBeUndefined();
    expect(validateDiscoveryExtension(extension)).toEqual({ valid: true });
  });

  it('carries less when the seller\'s metadata doesn\'t validate in full, and says so once', () => {
    const lines: Record<string, unknown>[] = [];
    const made = declarations(lines);
    // The example doesn't match the schema, and the body schema requires a field with no example body
    const mismatched: BazaarMetadata = {
      ...weather,
      method: 'PUT',
      input: { parameters: [], body: { contentType: 'application/json', schema: { type: 'object', required: ['city'] } } },
      output: { contentType: 'application/json', schema: { type: 'object', properties: { celsius: { type: 'string' } } } },
    };

    const first = bazaarOf(made.extensionsFor(mismatched, `${payUrl}/weather/oslo`));
    made.extensionsFor(mismatched, `${payUrl}/weather/rome`);

    expect(first.info).toEqual({ input: { type: 'http', method: 'PUT', bodyType: 'json', body: {}, pathParams: { city: 'oslo' } }, output: { type: 'json', example: { city: 'Oslo', celsius: 4 } } });
    expect(first.schema.properties).not.toHaveProperty('output.properties.example.properties');
    expect(validateDiscoveryExtension(first)).toEqual({ valid: true });
    expect(lines.filter(line => line['msg'] === 'An operation\'s x402 Bazaar metadata doesn\'t validate in full: the challenge carries less of it')).toEqual([
      expect.objectContaining({ level: 30, resource: mismatched.resource, method: 'PUT', dropped: 'the output schema' }),
    ]);
  });

  it('carries none without metadata, as for a routed call or an opted-out service (P-4), or for a method the Bazaar doesn\'t list', () => {
    const made = declarations();

    expect(made.extensionsFor(undefined, `${payUrl}/weather/oslo`)).toBeUndefined();
    expect(made.resourceOf(undefined)).toBeUndefined();
    expect(made.extensionsFor({ ...weather, method: 'OPTIONS' }, `${payUrl}/weather/oslo`)).toBeUndefined();
  });

  it.each([
    ['a literal colon', `${payUrl}/jobs/{job}:cancel`, `${payUrl}/jobs/7:cancel`],
    ['a parameter name the SDK doesn\'t read', `${payUrl}/items/{item-id}`, `${payUrl}/items/7`],
  ])('leaves out the route template for a path with %s, and still validates', (_case, resource, url) => {
    const extension = bazaarOf(declarations().extensionsFor({ ...weather, resource, input: { parameters: [], body: null } }, url));

    expect(extension.routeTemplate).toBeUndefined();
    expect(extension.info.input).toMatchObject({ method: 'GET' });
    expect(validateDiscoveryExtension(extension)).toEqual({ valid: true });
  });
});
