import * as Address from '@evolution-sdk/evolution/Address';
import * as Assets from '@evolution-sdk/evolution/Assets';
import { mainnet, preprod } from '@evolution-sdk/evolution/sdk/client/Chain';
import * as Client from '@evolution-sdk/evolution/sdk/client/Client';
import { addressFromSeed } from '@evolution-sdk/evolution/sdk/wallet/Derivation';
import * as Transaction from '@evolution-sdk/evolution/Transaction';

import { ServiceRouterError, type Secret } from '@servicerouter/common';
import type { Asset } from '@servicerouter/core';

/** The payout wallet couldn't build the run: too little USDM or ADA, most likely (PO-5). */
export class PayoutBuildError extends ServiceRouterError {
  readonly code = 'payout_build_failed';
}

export interface PayoutOutput {
  readonly address: string;
  // The payout asset's atomic units
  readonly quantity: bigint;
}

export interface BuiltPayoutTransaction {
  readonly txHash: string;
  // Signed, CBOR in hex
  readonly cbor: string;
}

/** Port: the payout wallet (PO-2, PO-3, PO-8). Holds the payout key, in the workers only. */
export interface PayoutWallet {
  readonly address: string;
  /** Builds and signs one transaction paying every output, valid until `validUntil`. Never submits it. */
  build(input: { readonly outputs: readonly PayoutOutput[]; readonly validUntil: Date }): Promise<BuiltPayoutTransaction>;
}

export interface CardanoPayoutWalletOptions {
  // PAYOUT_WALLET_MNEMONIC
  readonly mnemonic: Secret;
  // The payout asset: a Cardano asset of the registry (PO-2)
  readonly asset: Asset;
  readonly blockfrost: { readonly url: string; readonly projectId: Secret };
}

const chainOf = (asset: Asset) => {
  if (asset.network.id === 'cardano:mainnet')
    return mainnet;
  if (asset.network.id === 'cardano:preprod')
    return preprod;

  throw new PayoutBuildError(`Payouts are on Cardano mainnet or preprod, not ${asset.network.title}`);
};

/**
 * The Cardano payout wallet (PO-2, PO-3, PO-8): the first address of the mnemonic's account, which
 * the operator funds with USDM and ADA. Each transaction pays its outputs in the payout asset, each
 * with the minimum ADA it needs, and returns the change to the wallet. The platform pays the fee.
 */
export const createCardanoPayoutWallet = ({ mnemonic, asset, blockfrost }: CardanoPayoutWalletOptions): PayoutWallet => {
  const chain = chainOf(asset);
  const seed = mnemonic.expose().trim().replace(/\s+/g, ' ').toLowerCase();
  const address = Address.toBech32(addressFromSeed(seed, { networkId: chain.id }).address);
  const client = Client.make(chain).withBlockfrost({ baseUrl: blockfrost.url, projectId: blockfrost.projectId.expose() }).withSeed({ mnemonic: seed });
  const [policyId, assetName] = asset.address.split('.') as [string, string];

  return {
    address,
    build: async ({ outputs, validUntil }) => {
      if (outputs.length === 0)
        throw new PayoutBuildError('A payout transaction needs at least one output');

      let builder = client.newTx();
      for (const output of outputs)
        builder = builder.payToAddress({ address: Address.fromBech32(output.address), assets: Assets.addByHex(Assets.zero, policyId, assetName, output.quantity) });
      let signBuilder;
      try {
        signBuilder = await builder.setValidity({ to: BigInt(validUntil.getTime()) }).build({ changeAddress: Address.fromBech32(address), autoMinUtxo: true });
      }
      catch (error) {
        throw new PayoutBuildError('The payout wallet couldn\'t build the transaction: it may not hold enough USDM or ADA', { cause: error });
      }
      const { txHash } = signBuilder.chainResult();
      const submitBuilder = await signBuilder.sign();
      const unsigned = await signBuilder.toTransaction();
      const signed = new Transaction.Transaction({ body: unsigned.body, witnessSet: submitBuilder.witnessSet, isValid: true, auxiliaryData: null });

      return { txHash, cbor: Transaction.toCBORHex(signed) };
    },
  };
};
