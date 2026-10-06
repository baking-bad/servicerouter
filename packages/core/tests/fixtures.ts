import { readFileSync } from 'node:fs';

import { parseStrictYaml } from '@servicerouter/common';

import { buildPlatformConfig, type PlatformConfig, type ServiceConfigContext } from '../src/index.js';

export const examplePlatformConfigPath = new URL('../../../config/example.yaml', import.meta.url);

export const loadExamplePlatformDocument = (): Record<string, unknown> =>
  structuredClone(parseStrictYaml(readFileSync(examplePlatformConfigPath)).value);

export const examplePlatform: PlatformConfig = buildPlatformConfig(loadExamplePlatformDocument() as never);

// Placeholder bech32 addresses with valid checksums
export const preprodEnterpriseAddress = 'addr_test1vq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygswahgq5';
export const mainnetEnterpriseAddress = 'addr1v9zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3q09h6pt';

export const weatherOpenApiUrl = 'https://api.example.com/openapi.json';
export const weatherOpenApi = {
  openapi: '3.1.0',
  info: { title: 'Weather', version: '1.0.0' },
  paths: {
    '/weather/{city}': { get: { operationId: 'getWeather', responses: { 200: { description: 'OK' } } } },
    '/forecast/{city}': { get: { operationId: 'getForecast' } },
    '/admin/reset': { post: { operationId: 'adminReset' } },
  },
};

// The example from docs/architecture/service-registry.md, with a preprod payout address
export const exampleServiceConfig = `servicerouter:
  version: "1"

service:
  id: my-app
  title: My App
  summary: Weather forecasts for any city
  description: |
    Current weather and 14-day forecasts for any city.
  category: weather
  tags: [forecast, geo]
  links:
    homepage: https://example.com
    docs: https://example.com/docs
  contact:
    name: Your Name
    url: https://example.com/support
    email: support@example.com

payouts:
  default:
    asset: cardano-usdm
    address: ${preprodEnterpriseAddress}

payments:
  default:
    amount: "0.001"
  premium:
    amount: "0.01"

upstreams:
  - baseUrl: https://api.example.com
    name: main
    type: http
    openapi: ${weatherOpenApiUrl}
    auth: main-key

  - baseUrl: https://files.example.com
    name: files
    paths:
      /upload:
        post:
          operationId: uploadFile
          summary: Upload a file
    auth: [files-key, files-app]

routes:
  getWeather:
    payment: premium
  getForecast:
    target:
      path: /internal/forecast/{city}
  files/uploadFile:
    payment:
      amount: "0.01"
  adminReset:
    enabled: false

credentials:
  main-key:
    type: http
    scheme: bearer
    secret: weather-key
  files-key:
    type: apiKey
    in: header
    name: X-Api-Key
    secret: files-key
  files-app:
    type: apiKey
    in: header
    name: X-App-Id
    secret: files-app-id
`;

export const exampleContext: ServiceConfigContext = {
  platform: examplePlatform,
  openapiDocuments: new Map([[weatherOpenApiUrl, weatherOpenApi]]),
  secretNames: new Set(['weather-key', 'files-key', 'files-app-id']),
};

/** The example config as an object, to patch in tests. */
export const exampleServiceObject = (): Record<string, unknown> =>
  structuredClone(parseStrictYaml(exampleServiceConfig).value);

// Objects merge by key; other values replace. `undefined` deletes the key.
export const patch = (base: unknown, changes: unknown): unknown => {
  if (typeof base !== 'object' || base === null || Array.isArray(base) || typeof changes !== 'object' || changes === null || Array.isArray(changes))
    return changes;

  const result: Record<string, unknown> = { ...base as Record<string, unknown> };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined)
      delete result[key];
    else
      result[key] = patch(result[key], value);
  }

  return result;
};
