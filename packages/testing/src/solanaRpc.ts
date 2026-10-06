import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// The classic SPL token program, which owns USDC's mints
export const tokenProgramAddress = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 as Solana writes addresses and blockhashes. */
export const encodeBase58 = (bytes: Uint8Array): string => {
  let value = bytes.reduce((result, byte) => (result << 8n) | BigInt(byte), 0n);
  let text = '';
  while (value > 0n) {
    text = base58Alphabet[Number(value % 58n)] + text;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0)
      break;
    text = `1${text}`;
  }

  return text;
};

/** An SPL mint account's 82 bytes: no authority, decimals at byte 44, initialized at byte 45. */
const mintAccount = (decimals: number): string => {
  const data = Buffer.alloc(82);
  data[44] = decimals;
  data[45] = 1;

  return data.toString('base64');
};

export interface FakeSolanaRpc {
  readonly url: string;
  // JSON-RPC methods called, in order
  readonly calls: readonly string[];
  close(): Promise<void>;
}

/**
 * The two Solana RPC calls the x402 SDK's Solana client makes to build a payment: the mint's account
 * (any address is a USDC-like mint with 6 decimals), and a recent blockhash. Offline, on 127.0.0.1.
 */
export const startFakeSolanaRpc = async ({ decimals = 6 }: { readonly decimals?: number } = {}): Promise<FakeSolanaRpc> => {
  const calls: string[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const call = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: unknown; method: string };
      calls.push(call.method);
      const context = { slot: 1 };
      const result = call.method === 'getAccountInfo'
        ? { context, value: { data: [mintAccount(decimals), 'base64'], executable: false, lamports: 1_461_600, owner: tokenProgramAddress, rentEpoch: 0, space: 82 } }
        : call.method === 'getLatestBlockhash'
          ? { context, value: { blockhash: encodeBase58(randomBytes(32)), lastValidBlockHeight: 1_000 } }
          : undefined;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result === undefined
        ? { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: `${call.method} isn't faked` } }
        : { jsonrpc: '2.0', id: call.id, result }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
};
