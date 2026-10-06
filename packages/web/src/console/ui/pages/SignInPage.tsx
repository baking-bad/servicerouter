'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { ApiError } from '../../../api/http';
import { createHttpConsoleApi, signUp } from '../../api';
import type { Signup } from '../../types';
import { ErrorNotice, ShownOnce } from '../parts';
import { useConsole } from '../ConsoleRoot';

/** `/console`: sign in with a master key, sign up, or look around with sample data (WB-8, WB-10). */
export const SignInPage = () => {
  const { settings, session, signIn, notice } = useConsole();
  const router = useRouter();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<'signin' | 'signup' | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [created, setCreated] = useState<Signup | undefined>(undefined);
  const apiHost = new URL(settings.apiUrl).host;

  useEffect(() => {
    if (session && !created)
      router.replace('/console/overview');
  }, [session, created, router]);

  const submit = async () => {
    setBusy('signin');
    setError(undefined);
    try {
      // GET /v1/account checks the key; a payment key gets wrong_key_type with the reason (AK-4)
      await createHttpConsoleApi({ apiUrl: settings.apiUrl, key: key.trim() }).account();
      signIn({ kind: 'key', key: key.trim() });
    }
    catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    }
    finally {
      setBusy(undefined);
      setKey('');
    }
  };

  const create = async () => {
    setBusy('signup');
    setError(undefined);
    try {
      setCreated(await signUp(settings.apiUrl));
    }
    catch (caught) {
      setError(caught instanceof ApiError || caught instanceof Error ? caught : new Error(String(caught)));
    }
    finally {
      setBusy(undefined);
    }
  };

  if (created) {
    return (
      <section className="section narrow stack">
        <h1>Your account is ready</h1>
        <ShownOnce
          title="Your master key"
          value={created.masterKey}
          warning={`${created.notice} Give agents payment keys, never this one.`}
          onDone={() => {
            signIn({ kind: 'key', key: created.masterKey });
            setCreated(undefined);
          }}
        />
      </section>
    );
  }

  return (
    <section className="section narrow stack">
      <h1>Console</h1>
      <p className="lead">Your balance, payment keys, payments, and services. Sign in with your master key.</p>
      {notice ? <p className="notice">{notice}</p> : null}
      <ErrorNotice error={error} />
      <form
        className="card stack"
        onSubmit={event => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="stack" htmlFor="master-key">
          <span className="label">Master key</span>
          <input id="master-key" className="input mono" type="password" autoComplete="off" spellCheck={false} placeholder="srm_live_…" value={key} onChange={event => setKey(event.target.value)} required />
        </label>
        <div className="row"><button type="submit" className="button button-primary" disabled={busy !== undefined || key.trim() === ''}>{busy === 'signin' ? 'Signing in…' : 'Sign in'}</button></div>
        <p className="faint">The key stays in this tab: it is sent only to {apiHost}, kept until the tab closes, and never stored on this device or sent to this website.</p>
      </form>
      <div className="grid grid-2">
        <div className="card stack">
          <h3>New here?</h3>
          <p className="muted">One click creates an account and shows its master key once. No email, no card.</p>
          <div className="row"><button type="button" className="button" disabled={busy !== undefined} onClick={() => void create()}>{busy === 'signup' ? 'Creating…' : 'Create an account'}</button></div>
        </div>
        <div className="card stack">
          <h3>Just looking?</h3>
          <p className="muted">See the whole console with sample data. Nothing is real, and nothing is sent anywhere.</p>
          <div className="row"><button type="button" className="button" onClick={() => signIn({ kind: 'sample' })}>Try with sample data</button></div>
        </div>
      </div>
    </section>
  );
};
