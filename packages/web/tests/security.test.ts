import { describe, expect, it } from 'vitest';

import { contentSecurityPolicy, createNonce, securityHeaders } from '../src/security/csp';

const directives = (policy: string): Record<string, string> =>
  Object.fromEntries(policy.split('; ').map(directive => [directive.slice(0, directive.indexOf(' ')), directive.slice(directive.indexOf(' ') + 1)]));

describe('the Content-Security-Policy (WB-12)', () => {
  it('lets scripts run only with this response\'s nonce, and the browser talk only to the site and the Platform API', () => {
    const policy = directives(contentSecurityPolicy({ nonce: 'abc123==', apiUrl: 'https://api.servicerouter.ai/', development: false }));

    expect(policy['script-src']).toBe('\'self\' \'nonce-abc123==\' \'strict-dynamic\'');
    expect(policy['connect-src']).toBe('\'self\' https://api.servicerouter.ai');
    expect(policy['frame-ancestors']).toBe('\'none\'');
    expect(policy['default-src']).toBe('\'self\'');
    expect(policy['object-src']).toBe('\'none\'');
    expect(policy['font-src']).toBe('\'self\'');
  });

  it('names no third-party origin', () => {
    const policy = contentSecurityPolicy({ nonce: 'n', apiUrl: 'https://api.servicerouter.ai', development: false });

    expect([...policy.matchAll(/https?:\/\/[^\s;]+/g)].map(match => match[0])).toEqual(['https://api.servicerouter.ai']);
    expect(policy).not.toContain('unsafe-eval');
  });

  it('adds eval and the websocket only for next dev', () => {
    const policy = directives(contentSecurityPolicy({ nonce: 'n', apiUrl: 'http://localhost:8081', development: true }));

    expect(policy['script-src']).toContain('\'unsafe-eval\'');
    expect(policy['connect-src']).toBe('\'self\' http://localhost:8081 ws:');
  });

  it('makes a fresh 128-bit nonce for every response', () => {
    const nonces = new Set(Array.from({ length: 100 }, createNonce));

    expect(nonces.size).toBe(100);
    expect([...nonces].every(nonce => Buffer.from(nonce, 'base64').length === 16)).toBe(true);
  });

  it('sends nosniff and no referrer with every response', () => {
    expect(securityHeaders).toMatchObject({ 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  });
});
