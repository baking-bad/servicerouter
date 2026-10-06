import { describe, expect, it } from 'vitest';

import type { ValidationIssue } from '@servicerouter/common';

import {
  assumeHostsVerified, changesPayouts, findMovedSecrets, getSecretOrigins, getSecretUses, getUpstreamHosts, isSameRevision, parseServiceConfig,
  stateForActivation, validateServiceConfig, type HostState, type OwnershipStatus, type ServiceConfigContext, type ServiceConfigDocument,
} from '../../src/index.js';
import { exampleContext, exampleServiceConfig, exampleServiceObject, patch } from '../fixtures.js';

const configOf = (changes: unknown = {}): ServiceConfigDocument => patch(exampleServiceObject(), changes) as ServiceConfigDocument;

const errorsOf = (source: string | Record<string, unknown>, context: Partial<ServiceConfigContext> = {}): readonly ValidationIssue[] => {
  const result = validateServiceConfig(source, { ...exampleContext, ...context });
  if (result.ok)
    throw new Error('Expected validation to fail');

  return result.errors;
};

// The example's second upstream, files.example.com, sends files-key and files-app-id
const filesOnApiHost = exampleServiceConfig.replace('baseUrl: https://files.example.com', 'baseUrl: https://api.example.com/files');
const lineOf = (text: string, needle: string) => text.split('\n').findIndex(line => line.includes(needle)) + 1;

describe('secret uses (SC-10)', () => {
  it('maps each secret to the upstreams that send it, through the credentials in their auth', () => {
    expect(getSecretUses(configOf())).toEqual(new Map([
      ['weather-key', [{ upstream: 0, origin: 'https://api.example.com' }]],
      ['files-key', [{ upstream: 1, origin: 'https://files.example.com' }]],
      ['files-app-id', [{ upstream: 1, origin: 'https://files.example.com' }]],
    ]));
  });

  it('keeps the port and drops the path and trailing slash, as new URL(baseUrl).origin does', () => {
    const config = configOf({ upstreams: [{ ...configOf().upstreams[0], baseUrl: 'https://api.example.com:8443/v2/' }, configOf().upstreams[1]] });

    expect(getSecretOrigins(config).get('weather-key')).toBe('https://api.example.com:8443');
  });

  it('leaves out a secret whose credential no upstream uses: it has no origin', () => {
    const config = configOf({ credentials: { spare: { type: 'http', scheme: 'bearer', secret: 'spare-key' } } });

    expect(getSecretUses(config).has('spare-key')).toBe(false);
  });

  it('gives no origin to a secret sent to two origins', () => {
    const config = configOf({ credentials: { 'files-key': { secret: 'weather-key' } } });

    expect(getSecretUses(config).get('weather-key')).toHaveLength(2);
    expect(getSecretOrigins(config).has('weather-key')).toBe(false);
  });

  it('finds stored secrets that a config sends to another origin', () => {
    const stored = new Map([['weather-key', 'https://old.example.com'], ['files-key', 'https://files.example.com'], ['gone', 'https://x.io']]);

    expect(findMovedSecrets(configOf(), stored)).toEqual(['weather-key']);
  });
});

describe('host binding in pass 2 (SC-10)', () => {
  it('refuses a secret that upstreams on two origins send, at each upstream\'s auth', () => {
    const text = exampleServiceConfig.replace('secret: files-key', 'secret: weather-key');

    expect(errorsOf(text)).toEqual([
      {
        path: '/upstreams/0/auth',
        message: 'sends the secret "weather-key" to https://api.example.com, and other upstreams send it to https://files.example.com. '
          + 'A secret is bound to one host: give each host its own secret',
        line: lineOf(text, 'auth: main-key'),
        column: 11,
      },
      {
        path: '/upstreams/1/auth',
        message: 'sends the secret "weather-key" to https://files.example.com, and other upstreams send it to https://api.example.com. '
          + 'A secret is bound to one host: give each host its own secret',
        line: lineOf(text, 'auth: [files-key, files-app]'),
        column: 11,
      },
    ]);
  });

  it('lets upstreams on one origin share a secret', () => {
    const text = filesOnApiHost.replace('secret: files-key', 'secret: weather-key');

    expect(validateServiceConfig(text, exampleContext).ok).toBe(true);
  });

  it('refuses an upstream moved to another origin without its stored secrets, at its baseUrl with line and column, naming them', () => {
    const stored = new Map([['weather-key', 'https://api.example.com'], ['files-key', 'https://files.example.com'], ['files-app-id', 'https://files.example.com']]);

    expect(errorsOf(filesOnApiHost, { storedSecretOrigins: stored })).toEqual([{
      path: '/upstreams/1/baseUrl',
      message: 'moves the secrets "files-key", "files-app-id" from https://files.example.com to https://api.example.com. '
        + 'A secret is bound to its host: send them again in this request\'s secrets',
      line: lineOf(filesOnApiHost, 'baseUrl: https://api.example.com/files'),
      column: 14,
    }]);
  });

  it('names only the secrets that stay stored, so those sent again pass', () => {
    const storedWithout = (...sent: string[]) => new Map([
      ['weather-key', 'https://api.example.com'], ['files-key', 'https://files.example.com'], ['files-app-id', 'https://files.example.com'],
    ].filter(([name]) => !sent.includes(name!)) as [string, string][]);

    expect(errorsOf(filesOnApiHost, { storedSecretOrigins: storedWithout('files-key') })).toMatchObject([
      { path: '/upstreams/1/baseUrl', message: expect.stringMatching(/^moves the secret "files-app-id" from https:\/\/files\.example\.com to/) },
    ]);
    expect(validateServiceConfig(filesOnApiHost, { ...exampleContext, storedSecretOrigins: storedWithout('files-key', 'files-app-id') }).ok).toBe(true);
  });

  it('accepts stored secrets on the origins they are sealed for', () => {
    const stored = new Map([['weather-key', 'https://api.example.com'], ['files-key', 'https://files.example.com']]);

    expect(validateServiceConfig(exampleServiceConfig, { ...exampleContext, storedSecretOrigins: stored }).ok).toBe(true);
  });
});

describe('service state (SR-8, S2-D1)', () => {
  it('lists each upstream host once', () => {
    const config = parseServiceConfig(filesOnApiHost);

    expect(getUpstreamHosts(configOf())).toEqual(['api.example.com', 'files.example.com']);
    expect(config.ok && getUpstreamHosts(config.parsed.config)).toEqual(['api.example.com']);
  });

  it('activates live once every host is verified, pending until then, and suspended while a host is (SR-8, OV-5)', async () => {
    const asked: unknown[] = [];
    const statesOf = (states: Record<string, HostState>): OwnershipStatus => ({
      hostStates: async input => {
        asked.push(input);

        return new Map(Object.entries(states));
      },
    });

    expect(await stateForActivation(assumeHostsVerified, 'acct-1', configOf())).toBe('live');
    expect(await stateForActivation(statesOf({ 'api.example.com': 'verified' }), 'acct-1', configOf())).toBe('pending');
    expect(await stateForActivation(statesOf({ 'api.example.com': 'verified', 'files.example.com': 'missing' }), 'acct-1', configOf())).toBe('live');
    expect(await stateForActivation(statesOf({ 'api.example.com': 'suspended', 'files.example.com': 'verified' }), 'acct-1', configOf())).toBe('suspended');
    expect(asked[0]).toEqual({ accountId: 'acct-1', hosts: ['api.example.com', 'files.example.com'] });
  });
});

describe('revision helpers (SR-4, SR-13)', () => {
  const documents = new Map([['https://api.example.com/openapi.json', { openapi: '3.1.0', paths: { '/a': {}, '/b': {} } }]]);

  it('treats a config with other key order, formatting, or comments as the same revision (SR-4)', () => {
    const reverseKeys = (value: unknown): unknown => typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse().map(([key, nested]) => [key, reverseKeys(nested)]))
      : value;
    const reordered = reverseKeys(configOf()) as ServiceConfigDocument;
    const yaml = parseServiceConfig(`# A comment\n${exampleServiceConfig}`);

    expect(isSameRevision({ config: configOf(), openapiDocuments: documents }, { config: reordered, openapiDocuments: documents })).toBe(true);
    expect(yaml.ok && isSameRevision({ config: configOf(), openapiDocuments: documents }, { config: yaml.parsed.config, openapiDocuments: documents })).toBe(true);
  });

  it('treats a changed config or OpenAPI document as a new revision (SR-4)', () => {
    const changedDocument = new Map([['https://api.example.com/openapi.json', { openapi: '3.1.0', paths: { '/a': {} } }]]);

    expect(isSameRevision({ config: configOf(), openapiDocuments: documents }, { config: configOf({ payments: { default: { amount: '0.002' } } }), openapiDocuments: documents })).toBe(false);
    expect(isSameRevision({ config: configOf(), openapiDocuments: documents }, { config: configOf(), openapiDocuments: changedDocument })).toBe(false);
  });

  it('sees a payout change, but not on the first activation (SR-13)', () => {
    const otherAddress = configOf({ payouts: { default: { address: 'addr_test1vq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygswahgq6' } } });

    expect(changesPayouts(configOf(), otherAddress)).toBe(true);
    expect(changesPayouts(configOf(), configOf({ payments: { default: { amount: '0.002' } } }))).toBe(false);
    expect(changesPayouts(undefined, configOf())).toBe(false);
  });
});
