import { describe, expect, it } from 'vitest';

import { InvalidSettingError, isMocked, mockGroups, readSettings } from '../src/config';

describe('runtime settings (WB-6, WB-10)', () => {
  it('defaults to the production hosts, with every unbuilt group as sample data', () => {
    const settings = readSettings({});

    expect(settings).toMatchObject({ siteUrl: 'https://servicerouter.ai', apiUrl: 'https://api.servicerouter.ai', payUrl: 'https://pay.servicerouter.ai' });
    expect([...settings.mocks]).toEqual([...mockGroups]);
  });

  it('reads SITE_URL, API_URL, PAY_URL, and WEB_MOCKS, without trailing slashes', () => {
    const settings = readSettings({ SITE_URL: 'http://localhost:3000/', API_URL: 'http://localhost:8081', PAY_URL: 'https://pay.example.com', WEB_MOCKS: 'catalog, topup' });

    expect(settings).toMatchObject({ siteUrl: 'http://localhost:3000', apiUrl: 'http://localhost:8081', payUrl: 'https://pay.example.com' });
    expect(isMocked(settings, 'catalog')).toBe(true);
    expect(isMocked(settings, 'agent-docs')).toBe(false);
    expect(readSettings({ WEB_MOCKS: 'none' }).mocks.size).toBe(0);
  });

  it.each([
    ['a URL that isn\'t one', { API_URL: 'not a url' }, 'API_URL must be a URL'],
    ['credentials in a URL', { API_URL: 'https://user:secret@api.example.com' }, 'API_URL must be an http(s) URL without credentials'],
    ['another scheme', { SITE_URL: 'ftp://servicerouter.ai' }, 'SITE_URL must be an http(s) URL'],
    ['an unknown sample group', { WEB_MOCKS: 'catalog,payments' }, 'WEB_MOCKS names unknown groups: payments'],
  ])('refuses %s', (_case, env, message) => {
    expect(() => readSettings(env)).toThrow(InvalidSettingError);
    expect(() => readSettings(env)).toThrow(message);
  });

  it('has no sample group for service status: a signed-in account always reads its own (WB-10, T16 round 1)', () => {
    expect([...mockGroups]).toEqual(['catalog', 'agent-docs', 'topup']);
    expect(() => readSettings({ WEB_MOCKS: 'catalog,status' })).toThrow('WEB_MOCKS names unknown groups: status');
  });
});
