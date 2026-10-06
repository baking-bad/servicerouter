import { describe, expect, it } from 'vitest';

import { InvalidEnvironmentError, readCommit, readHost, readLogLevel, readPort } from '../../src/index.js';

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

describe('readLogLevel (L-11)', () => {
  it('lets LOG_LEVEL override the configured level, in any case, and keeps the configured one when unset', () => {
    expect(readLogLevel({ LOG_LEVEL: 'debug' }, 'info')).toBe('debug');
    expect(readLogLevel({ LOG_LEVEL: ' WARN ' }, 'info')).toBe('warn');
    expect(readLogLevel({ LOG_LEVEL: 'silent' }, 'info')).toBe('silent');
    expect(readLogLevel({}, 'error')).toBe('error');
    expect(readLogLevel({ LOG_LEVEL: '' }, 'error')).toBe('error');
  });

  it('refuses a level pino doesn\'t know, naming the ones it does', () => {
    expect(() => readLogLevel({ LOG_LEVEL: 'verbose' }, 'info')).toThrow(InvalidEnvironmentError);
    expect(() => readLogLevel({ LOG_LEVEL: 'verbose' }, 'info')).toThrow('LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent');
  });
});

describe('readCommit (L-1)', () => {
  it('reads the image\'s commit from GIT_SHA, and nothing that isn\'t a commit hash', () => {
    expect(readCommit({ GIT_SHA: 'F7B6FFB0123456789abcdef0123456789abcdef0' })).toBe('f7b6ffb0123456789abcdef0123456789abcdef0');
    expect(readCommit({ GIT_SHA: 'f7b6ffb' })).toBe('f7b6ffb');
    expect(readCommit({})).toBeUndefined();
    expect(readCommit({ GIT_SHA: 'master; rm -rf /' })).toBeUndefined();
  });
});
