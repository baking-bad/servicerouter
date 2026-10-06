import type { Topup } from '../api/types';

// Sample data for the top-up page while the `topup` group of WEB_MOCKS is on (WB-10), in DP-5's shape. The
// address is a syntactically valid Cardano mainnet address that nobody holds keys for: never send funds to it.

export const sampleTopup = (token: string): Topup => ({
  address: 'addr1v9zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3q09h6pt',
  asset: { name: 'cardano-usdm', symbol: 'USDM', network: 'cardano:mainnet', networkTitle: 'Cardano' },
  confirmationsRequired: 15,
  deposits: token === 'empty'
    ? []
    : [
      {
        transactionHash: 'a3f1c2d4e5b6978877665544332211ffeeddccbbaa99887766554433221100ab',
        outputIndex: 0,
        amount: '25',
        status: 'confirming',
        confirmations: 3,
        confirmationsRequired: 15,
        seenAt: '2026-10-06T19:50:00+08:00',
        creditedAt: null,
      },
      {
        transactionHash: '5c9e0b7a6d4f3e2c1b0a99887766554433221100ffeeddccbbaa998877665544',
        outputIndex: 1,
        amount: '10',
        status: 'credited',
        confirmations: 15,
        confirmationsRequired: 15,
        seenAt: '2026-10-06T19:50:00+08:00',
        creditedAt: '2026-10-06T19:50:00+08:00',
      },
      {
        transactionHash: '5c9e0b7a6d4f3e2c1b0a99887766554433221100ffeeddccbbaa998877665544',
        outputIndex: 0,
        // ADA alone, without USDM: not credited
        amount: null,
        status: 'not_credited',
        confirmations: 15,
        confirmationsRequired: 15,
        seenAt: '2026-10-06T19:50:00+08:00',
        creditedAt: null,
      },
    ],
});
