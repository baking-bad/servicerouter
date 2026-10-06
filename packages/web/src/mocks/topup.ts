import type { Topup } from '../api/types';

// Sample data for the top-up page until step 9 ships GET /v1/topup/{token} (WB-10). The address is a
// syntactically valid Cardano mainnet address that nobody holds keys for: never send funds to it.

export const sampleTopup = (token: string): Topup => ({
  address: 'addr1v9zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3q09h6pt',
  asset: { name: 'cardano-usdm', symbol: 'USDM', network: 'cardano:mainnet', networkTitle: 'Cardano' },
  deposits: token === 'empty'
    ? []
    : [
      {
        transactionHash: 'a3f1c2d4e5b6978877665544332211ffeeddccbbaa99887766554433221100ab',
        amount: '25',
        status: 'confirming',
        confirmations: 3,
        confirmationsRequired: 10,
        seenAt: '2026-10-06T19:50:00+08:00',
        creditedAt: null,
      },
      {
        transactionHash: '5c9e0b7a6d4f3e2c1b0a99887766554433221100ffeeddccbbaa998877665544',
        amount: '10',
        status: 'credited',
        confirmations: 10,
        confirmationsRequired: 10,
        seenAt: '2026-10-06T19:50:00+08:00',
        creditedAt: '2026-10-06T19:50:00+08:00',
      },
    ],
});
