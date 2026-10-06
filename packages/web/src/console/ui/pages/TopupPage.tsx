'use client';

import { CopyText } from '../../../components/CopyText';
import { SampleBadge } from '../../../components/SampleBadge';
import { displayUsd } from '../../../money';
import { useConsole, useConsoleData } from '../ConsoleRoot';
import { ConsoleHeading, ErrorNotice } from '../parts';

// The sample top-up page's token: the website serves it while the `topup` group of WEB_MOCKS is on (WB-10)
export const sampleTopupToken = 'sample';

/** `/console/topup`: where the account's deposits go (WB-3, DP-5). */
export const TopupPage = () => {
  const { settings } = useConsole();
  const { data, error } = useConsoleData(async consoleApi => ({ account: await consoleApi.account(), balance: await consoleApi.balance(), sample: consoleApi.sample }));

  return (
    <>
      <ConsoleHeading title="Top up" />
      <ErrorNotice error={error} />
      {data
        ? (
          <div className="stack">
            <p className="lead">Credits are a USD balance. Top up with USDM on Cardano, credited 1:1 once the deposit confirms. Available now: <strong>{displayUsd(data.balance.available)}</strong>.</p>
            {data.account.topupUrl
              ? (
                <div className="card stack">
                  {data.account.depositAddress
                    ? <><span className="label">Your deposit address</span><CopyText text={data.account.depositAddress.address} label="Copy address" /></>
                    : null}
                  <p className="muted">The top-up page shows the address as a QR code, and each deposit until it is credited. It needs no key, so you can open it on your phone.</p>
                  <div className="row"><a className="button button-primary" href={data.account.topupUrl}>Open your top-up page</a></div>
                </div>
              )
              : (
                <div className="card stack">
                  <div className="row"><h3>Deposits aren&apos;t open for your account yet</h3>{settings.topupMocked ? <SampleBadge /> : null}</div>
                  <p className="muted">Until they are, agents can pay each call with x402 or MPP from a wallet, without credits.</p>
                  {settings.topupMocked
                    ? <div className="row"><a className="button" href={`/topup/${sampleTopupToken}`}>See the top-up page with sample data</a></div>
                    : null}
                </div>
              )}
          </div>
        )
        : null}
    </>
  );
};
