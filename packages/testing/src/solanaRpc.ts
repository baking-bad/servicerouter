import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  address as toAddress, getAddressEncoder, getBase64Encoder, getCompiledTransactionMessageDecoder, getProgramDerivedAddress, getTransactionDecoder,
} from '@solana/kit';

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
  /** The owner's token accounts for the mint, as atomic amounts, for `getTokenAccountsByOwner`. Empty: none. */
  setTokenAccounts(owner: string, mint: string, amounts: readonly bigint[]): void;
  /** How `getTokenAccountsByOwner` fails from now on: a JSON-RPC error, a result without accounts, or not (undefined). */
  failTokenAccounts(mode: 'error' | 'malformed' | undefined): void;
  close(): Promise<void>;
}

/** A token account as `getTokenAccountsByOwner` answers it with `jsonParsed`. */
const tokenAccount = (owner: string, mint: string, amount: bigint, decimals: number) => ({
  pubkey: encodeBase58(randomBytes(32)),
  account: {
    data: {
      parsed: { info: { isNative: false, mint, owner, state: 'initialized', tokenAmount: { amount: amount.toString(), decimals, uiAmountString: amount.toString() } }, type: 'account' },
      program: 'spl-token',
      space: 165,
    },
    executable: false, lamports: 2_039_280, owner: tokenProgramAddress, rentEpoch: 0, space: 165,
  },
});

/**
 * The two Solana RPC calls the x402 SDK's Solana client makes to build a payment: the mint's account
 * (any address is a USDC-like mint with 6 decimals), and a recent blockhash. Also the treasury's
 * `getTokenAccountsByOwner`, from the accounts a test sets. Offline, on 127.0.0.1.
 */
export const startFakeSolanaRpc = async ({ decimals = 6 }: { readonly decimals?: number } = {}): Promise<FakeSolanaRpc> => {
  const calls: string[] = [];
  // By `<owner> <mint>`
  const accounts = new Map<string, readonly bigint[]>();
  let failure: 'error' | 'malformed' | undefined;
  const tokenAccounts = (params: unknown, context: { readonly slot: number }) => {
    const [owner, filter] = Array.isArray(params) ? params as [unknown, unknown] : [];
    const mint = typeof filter === 'object' && filter !== null ? (filter as { mint?: unknown }).mint : undefined;
    if (failure === 'malformed')
      return { context, value: null };

    return typeof owner === 'string' && typeof mint === 'string'
      ? { context, value: (accounts.get(`${owner} ${mint}`) ?? []).map(amount => tokenAccount(owner, mint, amount, decimals)) }
      : undefined;
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const call = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: unknown; method: string; params?: unknown };
      calls.push(call.method);
      const context = { slot: 1 };
      const result = call.method === 'getAccountInfo'
        ? { context, value: { data: [mintAccount(decimals), 'base64'], executable: false, lamports: 1_461_600, owner: tokenProgramAddress, rentEpoch: 0, space: 82 } }
        : call.method === 'getLatestBlockhash'
          ? { context, value: { blockhash: encodeBase58(randomBytes(32)), lastValidBlockHeight: 1_000 } }
          : call.method === 'getTokenAccountsByOwner' && failure !== 'error'
            ? tokenAccounts(call.params, context)
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
    setTokenAccounts: (owner, mint, amounts) => {
      accounts.set(`${owner} ${mint}`, [...amounts]);
    },
    failTokenAccounts: mode => {
      failure = mode;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
};

// The associated token account program: a wallet's token account for a mint is its address
const associatedTokenProgram = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
// The token program's TransferChecked instruction: discriminator, amount (u64, little-endian), decimals
const transferCheckedDiscriminator = 12;

/** A wallet's associated token account for a mint of the classic token program, where x402 sends USDC on Solana. */
export const associatedTokenAddress = async (owner: string, mint: string): Promise<string> => {
  const encoder = getAddressEncoder();
  const [address] = await getProgramDerivedAddress({
    programAddress: toAddress(associatedTokenProgram),
    seeds: [encoder.encode(toAddress(owner)), encoder.encode(toAddress(tokenProgramAddress)), encoder.encode(toAddress(mint))],
  });

  return address;
};

/** What a signed x402 payment on Solana does, read from its base64 transaction (the `exact` scheme's payload). */
export interface SolanaPayment {
  // The account that pays the transaction's fee: the first of the message
  readonly feePayer: string;
  // Who signed it already, and who must still sign
  readonly signedBy: readonly string[];
  readonly unsignedBy: readonly string[];
  // Its TransferChecked instruction, if any
  readonly transfer: {
    readonly source: string;
    readonly mint: string;
    readonly destination: string;
    readonly authority: string;
    readonly amount: bigint;
    readonly decimals: number;
  } | undefined;
}

/** Decodes a signed x402 payment on Solana, so a test can check its fee payer, signers, and transfer. */
export const decodeSolanaPayment = (transaction: string): SolanaPayment => {
  const decoded = getTransactionDecoder().decode(getBase64Encoder().encode(transaction));
  const message = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
  const accounts = message.staticAccounts.map(String);
  const signatures = Object.entries(decoded.signatures);
  const transfer = (message.instructions ?? []).find(instruction =>
    accounts[instruction.programAddressIndex] === tokenProgramAddress && instruction.data?.[0] === transferCheckedDiscriminator);
  const data = transfer?.data;
  const [source, mint, destination, authority] = (transfer?.accountIndices ?? []).map(index => accounts[index] ?? '');

  return {
    feePayer: accounts[0] ?? '',
    signedBy: signatures.filter(([, signature]) => signature !== null).map(([address]) => address),
    unsignedBy: signatures.filter(([, signature]) => signature === null).map(([address]) => address),
    transfer: data && data.length >= 10
      ? { source: source!, mint: mint!, destination: destination!, authority: authority!, amount: Buffer.from(data).readBigUInt64LE(1), decimals: data[9]! }
      : undefined,
  };
};
