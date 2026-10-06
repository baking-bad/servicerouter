// Where the console keeps who is signed in (WB-8): this tab only. `sessionStorage` survives a reload and
// is gone when the tab closes. Never localStorage, never a cookie, and never sent to the web server.

export const sessionKey = 'servicerouter.console';

/** Signed in with a master key, or looking around with sample data (WB-10). */
export type ConsoleSession = { readonly kind: 'key'; readonly key: string } | { readonly kind: 'sample' };

/** The part of `Storage` the session uses, so tests can pass their own. */
export type SessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const parse = (raw: string | null): ConsoleSession | undefined => {
  if (raw === null)
    return undefined;
  try {
    const value = JSON.parse(raw) as Partial<{ kind: string; key: unknown }>;
    if (value.kind === 'sample')
      return { kind: 'sample' };
    if (value.kind === 'key' && typeof value.key === 'string' && value.key !== '')
      return { kind: 'key', key: value.key };
  }
  catch {
    // Not ours: treated as signed out
  }

  return undefined;
};

export const readSession = (storage: SessionStorage): ConsoleSession | undefined => parse(storage.getItem(sessionKey));

export const writeSession = (storage: SessionStorage, session: ConsoleSession): void => {
  storage.setItem(sessionKey, JSON.stringify(session));
};

/** Signing out: the key is gone from the tab. */
export const clearSession = (storage: SessionStorage): void => {
  storage.removeItem(sessionKey);
};

/** The tab's session storage, or none where the browser blocks it. */
export const tabStorage = (): SessionStorage | undefined => {
  try {
    return globalThis.sessionStorage;
  }
  catch {
    return undefined;
  }
};
