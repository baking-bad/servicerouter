import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { getTopup } from '../../../src/api/topup';
import { CopyText } from '../../../src/components/CopyText';
import { SampleBadge } from '../../../src/components/SampleBadge';
import { readSettings } from '../../../src/config';
import { depositAmount, depositStatusTitles } from '../../../src/content';
import { shortDate } from '../../../src/format';
import { qrSvg } from '../../../src/qr';

interface TopupProps {
  readonly params: Promise<{ readonly token: string }>;
}

export const generateMetadata = async ({ params }: TopupProps): Promise<Metadata> => ({
  title: 'Top up',
  // A top-up link belongs to one account: never indexed
  robots: { index: false, follow: false },
  alternates: { types: { 'text/markdown': `/topup/${(await params).token}.md` } },
});

const TopupPage = async ({ params }: TopupProps) => {
  const { token } = await params;
  const found = await getTopup(readSettings(), token);
  if (!found)
    notFound();
  const { value: topup, sample } = found;
  const qr = await qrSvg(topup.address);

  return (
    <div className="container">
      <section className="section stack">
        <div className="row"><h1>Top up your credits</h1><SampleBadge sample={sample} /></div>
        <p className="lead">Send {topup.asset.symbol} on {topup.asset.networkTitle}. It is credited 1:1 in USD once the deposit confirms.</p>
        {sample ? <p className="notice notice-danger">This is a sample address. Never send funds to it.</p> : null}
      </section>

      <section className="section split">
        <div className="card stack">
          <span className="label">Deposit address</span>
          <CopyText text={topup.address} label="Copy address" />
          <div className="row">
            <span className="badge badge-mint">{topup.asset.symbol}</span>
            <span className="badge">{topup.asset.networkTitle}</span>
            <code className="faint">{topup.asset.network}</code>
          </div>
          <p className="notice">Send only {topup.asset.symbol} on {topup.asset.networkTitle}. Other assets aren&apos;t credited.</p>
        </div>
        <div className="card stack center">
          <div className="qr" role="img" aria-label={`QR code of the address ${topup.address}`} data-qr={topup.address} dangerouslySetInnerHTML={{ __html: qr }} />
          <span className="faint">Scan with your wallet</span>
        </div>
      </section>

      <section className="section stack">
        <h2>Deposits</h2>
        {topup.deposits.length === 0
          ? <div className="card muted">No deposit yet. This page shows it as soon as it is seen on chain.</div>
          : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Seen</th><th className="num">Amount</th><th>Status</th><th className="num">Confirmations</th><th>Transaction</th></tr></thead>
                <tbody>
                  {topup.deposits.map(deposit => (
                    <tr key={`${deposit.transactionHash}:${deposit.outputIndex}`}>
                      <td>{shortDate(deposit.seenAt)}</td>
                      <td className="num">{depositAmount(deposit.amount)}</td>
                      <td><span className={deposit.status === 'credited' ? 'badge badge-mint' : 'badge'}>{depositStatusTitles[deposit.status]}</span></td>
                      <td className="num">{deposit.confirmations}/{deposit.confirmationsRequired}</td>
                      <td><code className="faint">{deposit.transactionHash.slice(0, 10)}…{deposit.transactionHash.slice(-6)}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </section>
    </div>
  );
};

export default TopupPage;
