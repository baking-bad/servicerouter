import { describe, expect, it } from 'vitest';

import { InvalidEnvironmentError, readHost, readPort } from '../../src/index.js';

describe('readPort', () => {
  it('takes the port from the environment, or the app\'s default when unset or empty', () => {
    expect(readPort({ PORT: '8181' }, 'PORT', 8081)).toBe(8181);
    expect(readPort({ PORT: ' 0 ' }, 'PORT', 8081)).toBe(0);
    expect(readPort({}, 'PORT', 8081)).toBe(8081);
    expect(readPort({ PORT: '' }, 'PORT', 8081)).toBe(8081);
  });

  it.each(['http', '-1', '1.5', '65536', '1e3', '0x50'])('rejects %s', value => {
    expect(() => readPort({ METRICS_PORT: value }, 'METRICS_PORT', 9081)).toThrow(InvalidEnvironmentError);
    expect(() => readPort({ METRICS_PORT: value }, 'METRICS_PORT', 9081)).toThrow('METRICS_PORT must be a port number from 0 to 65535');
  });
});

describe('readHost', () => {
  it('binds every interface unless HOST is set', () => {
    expect(readHost({})).toBe('0.0.0.0');
    expect(readHost({ HOST: '127.0.0.1' })).toBe('127.0.0.1');
  });
});
