// The website's settings, read from the environment at runtime, so one image serves every deployment
// (WB-6). The website reads only the public Platform API (WB-2): no database, no platform config, no
// secrets.

/** Endpoint groups the website can serve from sample data until their step ships (WB-10). */
export const mockGroups = ['catalog', 'agent-docs', 'topup', 'status'] as const;
export type MockGroup = typeof mockGroups[number];

export interface SiteSettings {
  // The canonical website origin, such as https://servicerouter.ai
  readonly siteUrl: string;
  // The public Platform API, such as https://api.servicerouter.ai
  readonly apiUrl: string;
  // The paid host, such as https://pay.servicerouter.ai
  readonly payUrl: string;
  // Groups served from sample data
  readonly mocks: ReadonlySet<MockGroup>;
}

export const defaultSettings = {
  siteUrl: 'https://servicerouter.ai',
  apiUrl: 'https://api.servicerouter.ai',
  payUrl: 'https://pay.servicerouter.ai',
  // Everything the Platform API can't answer yet: catalog (step 13), agent docs (step 10),
  // top-up data (step 9), and service status (step 8)
  mocks: mockGroups.join(','),
} as const;

export class InvalidSettingError extends Error {
  constructor(readonly variable: string, message: string) {
    super(`${variable} ${message}`);
  }
}

// An HTTP(S) origin without a path, or with a path prefix, and never a trailing slash
const readUrl = (env: Readonly<Record<string, string | undefined>>, variable: string, fallback: string): string => {
  const value = env[variable]?.trim() || fallback;
  let url: URL;
  try {
    url = new URL(value);
  }
  catch {
    throw new InvalidSettingError(variable, `must be a URL, such as ${fallback}`);
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash)
    throw new InvalidSettingError(variable, 'must be an http(s) URL without credentials, a query, or a fragment');

  return value.replace(/\/+$/, '');
};

const readMocks = (value: string | undefined): ReadonlySet<MockGroup> => {
  const names = (value ?? defaultSettings.mocks).split(',').map(name => name.trim()).filter(name => name !== '' && name !== 'none');
  const unknown = names.filter(name => !(mockGroups as readonly string[]).includes(name));
  if (unknown.length > 0)
    throw new InvalidSettingError('WEB_MOCKS', `names unknown groups: ${unknown.join(', ')}. Known: ${mockGroups.join(', ')}, or none`);

  return new Set(names as MockGroup[]);
};

/** The settings from `SITE_URL`, `API_URL`, `PAY_URL`, and `WEB_MOCKS`, with the production defaults. */
export const readSettings = (env: Readonly<Record<string, string | undefined>> = process.env): SiteSettings => ({
  siteUrl: readUrl(env, 'SITE_URL', defaultSettings.siteUrl),
  apiUrl: readUrl(env, 'API_URL', defaultSettings.apiUrl),
  payUrl: readUrl(env, 'PAY_URL', defaultSettings.payUrl),
  mocks: readMocks(env['WEB_MOCKS']),
});

/** Whether a group is served from sample data. */
export const isMocked = (settings: SiteSettings, group: MockGroup): boolean => settings.mocks.has(group);
