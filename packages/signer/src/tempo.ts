import { Challenge, Credential } from 'mppx';
import { Mppx, tempo as tempoCharge } from 'mppx/client';
import { BaseError, createClient, http, type Chain, type Client, type Hex, type LocalAccount } from 'viem';
import { tempo, tempoModerato } from 'viem/chains';
import { Transaction } from 'viem/tempo';

import type { MicroUsd } from '@servicerouter/common';
import type { NetworkInfo } from '@servicerouter/core';

// The Tempo chains platform config allows, from viem's definitions
const chains: Readonly<Record<string, Chain>> = {
  [`eip155:${tempo.id}`]: tempo,
  [`eip155:${tempoModerato.id}`]: tempoModerato,
};

/** The Tempo RPC of `mpp.network` (PC-6), as the Signer reads it: `mpp.rpcUrl`, or the chain's public RPC. */
export const createTempoClient = ({ network, url, timeoutMs }: {
  readonly network: NetworkInfo;
  readonly url: string | undefined;
  readonly timeoutMs: number;
}): Client => {
  const chain = chains[network.id];
  if (!chain)
    throw new Error(`${network.id} isn't a Tempo network viem knows`);
  const rpcUrl = url ?? chain.rpcUrls.default.http[0];
  if (!rpcUrl)
    throw new Error(`viem has no public RPC for ${network.id}. Set mpp.rpcUrl`);

  return createClient({ chain, transport: http(rpcUrl, { timeout: timeoutMs, retryCount: 0 }) });
};

/**
 * The `Authorization: Payment …` value for a target's Tempo charge (SG-2, SG-8): `mppx`'s client signs a
 * Tempo transaction in pull mode, pinned to the client's chain. The target broadcasts it.
 */
export const signTempoCharge = async ({ account, client, challenge }: {
  readonly account: LocalAccount;
  readonly client: Client;
  readonly challenge: Challenge.Challenge;
}): Promise<string> => {
  const mppx = Mppx.create({
    methods: [tempoCharge.charge({ account, getClient: () => client, mode: 'pull', ...client.chain ? { expectedChainId: client.chain.id } : {} })],
    polyfill: false,
  });

  return mppx.createCredential(new Response(null, { status: 402, headers: { 'www-authenticate': Challenge.serialize(challenge) } }));
};

// Tempo prices gas in attodollars (10^-18 USD): a 6-decimal stablecoin pays a millionth of that
const attodollarsPerMicroUsd = 10n ** 12n;

/**
 * The most our signed Tempo transaction can pay in fees, in micro-USD, rounded up: its gas limit at its
 * maximum fee per gas. Its wallet pays it in the stablecoin, unless the target sponsors it.
 */
export const maxFeeOf = (credential: string): MicroUsd => {
  const { payload } = Credential.deserialize<{ readonly signature?: Hex }>(credential);
  if (typeof payload.signature !== 'string')
    return 0n as MicroUsd;
  const { gas, maxFeePerGas } = Transaction.deserialize(payload.signature) as { readonly gas?: bigint; readonly maxFeePerGas?: bigint };
  const most = (gas ?? 0n) * (maxFeePerGas ?? 0n);

  return ((most + attodollarsPerMicroUsd - 1n) / attodollarsPerMicroUsd) as MicroUsd;
};

/**
 * An error's one-line reason, for logs. viem's full message carries the request, so it never reaches a
 * log (rule 10).
 */
export const errorReason = (error: unknown): string => error instanceof BaseError
  ? error.shortMessage
  : error instanceof Error ? error.message.split('\n', 1)[0]!.slice(0, 200) : 'unknown error';
