'use client';

import { useState } from 'react';

import { shortDate } from '../../../format';
import { useConsole, useConsoleData } from '../ConsoleRoot';
import { ConfirmButton, ConsoleHeading, ErrorNotice, ShownOnce } from '../parts';

/** `/console/account`: the account, rotating the master key (AK-5), and signing out. */
export const AccountPage = () => {
  const { api, session, signIn, signOut } = useConsole();
  const { data, error } = useConsoleData(consoleApi => consoleApi.account());
  const [rotated, setRotated] = useState<string | undefined>(undefined);
  const [rotateError, setRotateError] = useState<Error | undefined>(undefined);

  return (
    <>
      <ConsoleHeading title="Account" />
      <ErrorNotice error={error ?? rotateError} />
      {data
        ? (
          <div className="grid grid-2">
            <div className="card stack">
              <span className="label">Account ID</span>
              <code className="mono">{data.id}</code>
              <span className="label mt-8">Created</span>
              <span>{shortDate(data.createdAt)}</span>
              <span className="label mt-8">Email</span>
              <span className="muted">{data.email ?? 'None. Email and recovery come after launch: keep your master key safe, because a lost one can\'t be recovered.'}</span>
            </div>
            <div className="card stack">
              <h3>Master key</h3>
              <p className="muted">Rotate it if it may have leaked. The new key is shown once, and the old one stops working at once. Payment keys keep working.</p>
              {rotated
                ? (
                  <ShownOnce
                    title="Your new master key"
                    value={rotated}
                    warning="It is shown only now. The old master key no longer works."
                    onDone={() => {
                      if (session?.kind === 'key')
                        signIn({ kind: 'key', key: rotated });
                      setRotated(undefined);
                    }}
                  />
                )
                : (
                  <div className="row">
                    <ConfirmButton
                      label="Rotate the master key"
                      confirm="Rotate now"
                      onConfirm={async () => {
                        setRotateError(undefined);
                        try {
                          setRotated(await api!.rotateMasterKey());
                        }
                        catch (caught) {
                          setRotateError(caught instanceof Error ? caught : new Error(String(caught)));
                        }
                      }}
                    />
                  </div>
                )}
              <h3 className="mt-8">Sign out</h3>
              <p className="muted">Removes the key from this tab.</p>
              <div className="row"><button type="button" className="button" onClick={() => signOut()}>Sign out</button></div>
            </div>
          </div>
        )
        : null}
    </>
  );
};
