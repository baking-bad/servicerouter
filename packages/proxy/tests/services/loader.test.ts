import { beforeAll, describe, expect, it } from 'vitest';

import { createLogger, parseStrictYaml, Secret, SecretDestroyedError, type ServiceId } from '@servicerouter/common';
import { loadPlatformConfig, type PlatformConfig, type ServiceConfigDocument, type ServingService, type StoredSecret } from '@servicerouter/core';
import { createTestSecretKeys, type TestSecretKeys } from '@servicerouter/testing';

import { createServiceLoader, disposeService, type LoadedService } from '../../src/services/loader.js';

let keys: TestSecretKeys;
let platform: PlatformConfig;

beforeAll(async () => {
  [keys, platform] = await Promise.all([createTestSecretKeys(), loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } })]);
});

const config = parseStrictYaml(`servicerouter:
  version: "1"
service:
  id: my-app
  title: My App
  description: Weather.
  category: weather
payouts:
  default:
    asset: cardano-usdm
    address: addr_test1vq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygswahgq5
payments:
  default:
    amount: "0.001"
upstreams:
  - baseUrl: https://api.example.com/v2
    paths:
      /weather/{city}:
        get:
          operationId: getWeather
          responses: { "200": { description: OK } }
    auth: main-key
credentials:
  main-key:
    type: http
    scheme: bearer
    secret: weather-key
`).value as unknown as ServiceConfigDocument;

const origin = 'https://api.example.com';

const sealedFor = (sealOrigin: string, value = 'sk-live-1'): StoredSecret => ({
  name: 'weather-key',
  origin,
  updatedAt: new Date('2026-10-06T19:50:00+08:00'),
  sealed: keys.sealer.seal({ serviceId: 'my-app', name: 'weather-key', origin: sealOrigin, value: Secret.from(value) }),
});

const serving = (changes: Partial<ServingService> = {}): ServingService => ({
  serviceId: 'my-app' as ServiceId,
  state: 'live',
  revision: 3,
  config,
  openapiDocuments: new Map(),
  secrets: [sealedFor(origin)],
  ...changes,
});

const loaderFor = (service: ServingService | undefined) => {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({}, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
  const load = createServiceLoader({ services: { loadForServing: async () => service }, opener: keys.opener, platform, logger });

  return { load, lines };
};

describe('loading a service for the runtime cache (PX-3, SC-5, SC-10)', () => {
  it('compiles the active revision and opens each secret with its runtime upstream\'s origin', async () => {
    const { load } = loaderFor(serving());

    const found = await load('my-app');

    const loaded = found.kind === 'value' ? found.value as LoadedService : undefined;
    expect(loaded?.runtime).toMatchObject({ serviceId: 'my-app', revision: 3, state: 'live' });
    expect(loaded?.secrets.get('weather-key')?.expose()).toBe('sk-live-1');
  });

  it('never opens with the origin stored on the row: a value sealed for another host makes the service unavailable', async () => {
    // The row claims the right origin, but its value was sealed for another host
    const { load, lines } = loaderFor(serving({ secrets: [sealedFor('https://evil.example.net')] }));

    expect(await load('my-app')).toEqual({ kind: 'value', value: 'unavailable' });
    expect(lines).toContainEqual(expect.objectContaining({ serviceId: 'my-app', secretName: 'weather-key', msg: 'A secret the service needs doesn\'t open' }));
  });

  it('opens a secret whose stored origin is stale, when its value is sealed for the runtime\'s origin: the row\'s origin is ignored', async () => {
    const { load } = loaderFor(serving({ secrets: [{ ...sealedFor(origin), origin: 'https://stale.example.net' }] }));

    const found = await load('my-app');

    expect(found.kind === 'value' && found.value !== 'unavailable' && found.value.secrets.get('weather-key')?.expose()).toBe('sk-live-1');
  });

  it('makes the service unavailable when a secret its credentials use is missing, and logs the service and secret', async () => {
    const { load, lines } = loaderFor(serving({ secrets: [] }));

    expect(await load('my-app')).toEqual({ kind: 'value', value: 'unavailable' });
    expect(lines).toContainEqual(expect.objectContaining({ serviceId: 'my-app', secretName: 'weather-key', msg: 'A secret the service needs is not set' }));
  });

  it('opens nothing for a service that isn\'t live, since it serves nothing', async () => {
    const { load } = loaderFor(serving({ state: 'pending', secrets: [] }));

    const found = await load('my-app');

    expect(found.kind === 'value' && found.value !== 'unavailable' && [found.value.runtime.state, found.value.secrets.size]).toEqual(['pending', 0]);
  });

  it('answers an unknown service with nothing to serve', async () => {
    expect(await loaderFor(undefined).load('nope')).toEqual({ kind: 'none' });
  });

  it('destroys the opened secrets when the service leaves the cache (SC-5)', async () => {
    const found = await loaderFor(serving()).load('my-app');
    const loaded = found.kind === 'value' ? found.value as LoadedService : undefined;

    disposeService(loaded!);

    expect(() => loaded!.secrets.get('weather-key')!.expose()).toThrow(SecretDestroyedError);
  });
});
