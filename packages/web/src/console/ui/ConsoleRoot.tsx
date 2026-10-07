'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { ApiError } from '../../api/http';
import { SampleBadge } from '../../components/SampleBadge';
import { createHttpConsoleApi, signingOutOnUnauthorized, type ConsoleApi } from '../api';
import { createSampleConsoleApi } from '../sample';
import { clearSession, readSession, tabStorage, writeSession, type ConsoleSession } from '../session';

/** What the console needs from the server: the Platform API's address, and what is sample data (WB-10). */
export interface ConsoleSettings {
  readonly apiUrl: string;
  readonly siteUrl: string;
  readonly payUrl: string;
  readonly topupMocked: boolean;
  readonly agentDocsMocked: boolean;
  readonly catalogMocked: boolean;
}

interface ConsoleContextValue {
  readonly settings: ConsoleSettings;
  // Undefined while the tab's session is read, null when signed out
  readonly session: ConsoleSession | null | undefined;
  readonly api: ConsoleApi | undefined;
  readonly signIn: (session: ConsoleSession) => void;
  readonly signOut: (reason?: string) => void;
  // Why the last session ended, such as a revoked key
  readonly notice: string | undefined;
}

const ConsoleContext = createContext<ConsoleContextValue | undefined>(undefined);

export const useConsole = (): ConsoleContextValue => {
  const value = useContext(ConsoleContext);
  if (!value)
    throw new Error('useConsole runs inside ConsoleRoot');

  return value;
};

/** Loads data with the console's API. A 401 signs out, in the API itself. */
export const useConsoleData = <TResult,>(load: (api: ConsoleApi) => Promise<TResult>, dependencies: readonly unknown[] = []) => {
  const { api } = useConsole();
  const [state, setState] = useState<{ readonly data?: TResult; readonly error?: ApiError | Error; readonly loading: boolean }>({ loading: true });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!api)
      return undefined;
    let current = true;
    setState(previous => ({ ...previous, loading: true }));
    load(api).then(
      data => current && setState({ data, loading: false }),
      (error: unknown) => {
        if (!current)
          return;
        // The API signed out already
        if (error instanceof ApiError && error.status === 401)
          return;
        setState({ error: error instanceof Error ? error : new Error(String(error)), loading: false });
      },
    );

    return () => {
      current = false;
    };
    // `load` is a new function every render: the caller lists what it depends on instead
  }, [api, version, ...dependencies]);
  const reload = useCallback(() => setVersion(value => value + 1), []);

  return { ...state, reload };
};

const sections = [
  { href: '/console/overview', label: 'Overview' },
  { href: '/console/keys', label: 'Payment keys' },
  { href: '/console/payments', label: 'Payments' },
  { href: '/console/services', label: 'Services' },
  { href: '/console/topup', label: 'Top up' },
  { href: '/console/account', label: 'Account' },
] as const;

/**
 * The console (WB-8): who is signed in lives in this tab only, and the browser calls the Platform API
 * with it directly. Every page but the sign-in page needs a session.
 */
export const ConsoleRoot = ({ settings, children }: { readonly settings: ConsoleSettings; readonly children: ReactNode }) => {
  const [session, setSession] = useState<ConsoleSession | null | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    const storage = tabStorage();
    setSession((storage && readSession(storage)) ?? null);
  }, []);

  const signIn = useCallback((next: ConsoleSession) => {
    const storage = tabStorage();
    if (storage)
      writeSession(storage, next);
    setNotice(undefined);
    setSession(next);
  }, []);

  const signOut = useCallback((reason?: string) => {
    const storage = tabStorage();
    if (storage)
      clearSession(storage);
    setNotice(reason);
    setSession(null);
    router.replace('/console');
  }, [router]);

  const api = useMemo(() => {
    if (!session)
      return undefined;

    return session.kind === 'sample'
      ? createSampleConsoleApi()
      : signingOutOnUnauthorized(
        createHttpConsoleApi({ apiUrl: settings.apiUrl, key: session.key }),
        () => signOut('Your master key no longer works here. Sign in again.'),
      );
  }, [session, settings.apiUrl, signOut]);

  useEffect(() => {
    if (session === null && pathname !== '/console')
      router.replace('/console');
  }, [session, pathname, router]);

  const value = useMemo(() => ({ settings, session, api, signIn, signOut, notice }), [settings, session, api, signIn, signOut, notice]);
  const signedIn = session !== null && session !== undefined;

  return (
    <ConsoleContext.Provider value={value}>
      <div className="container console">
        {signedIn && pathname !== '/console'
          ? (
            <nav className="console-nav" aria-label="Console">
              {sections.map(section => (
                <Link key={section.href} href={section.href} aria-current={pathname.startsWith(section.href) ? 'page' : undefined}>{section.label}</Link>
              ))}
              <span className="console-nav-end">
                <SampleBadge sample={session.kind === 'sample'} />
                <button type="button" className="button button-small" onClick={() => signOut()}>Sign out</button>
              </span>
            </nav>
          )
          : null}
        {session === undefined || (session === null && pathname !== '/console') ? <p className="faint section">Loading…</p> : children}
      </div>
    </ConsoleContext.Provider>
  );
};
