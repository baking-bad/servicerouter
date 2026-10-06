import { Challenge, Credential, Errors, Receipt as MppReceipt, Store } from 'mppx';
import { formatUnits, isAddressEqual, keccak256, type Address, type Hex } from 'viem';
import { Transaction } from 'viem/tempo';

import { isRecord, usdToAtomic, withTimeout, type Clock, type Logger, type LogSink, type Secret } from '@servicerouter/common';

import { detectMpp, type Credential as RailCredential } from '../credentials.js';
import { PaymentInvalidError, PaymentUnavailableError, SettlementFailedError } from '../errors.js';
import type { PaymentRecorder, SettlementLedger } from '../ports.js';
import type { Authorization, PaymentRail, Quote, Receipt } from '../rail.js';
import { errorReason, rpcFailure } from './rpc.js';
import { paymentReceiptHeader, toMppSettlementRequest, type MppSettlementRequest } from './settlement.js';
import type { MppAsset, MppSetup } from './setup.js';

// Our claim on a credential's transaction while it is authorized, beside `mppx`'s own at broadcast
const authorizedKey = (hash: Hex): string => `authorized:${hash.toLowerCase()}`;
const reasonLength = 200;

/**
 * A Tempo charge request for one asset: what the challenge offers and what a credential must match
 * (PR-9). A type, not an interface, so `mppx` takes it as a record.
 */
export type MppChargeRequest = {
  readonly amount: string;
  readonly currency: Address;
  readonly decimals: number;
  readonly recipient: Address;
  readonly chainId: number;
  readonly supportedModes: readonly ['pull'];
};

/** What the MPP rail keeps between validating and broadcasting. */
export interface MppAuthorization extends Authorization {
  readonly rail: 'mpp';
  // Authorization: Payment …, until the broadcast or the abort
  readonly credential: Secret;
  readonly request: MppChargeRequest;
  // The canonical pay URL the challenge is bound to (PX-10)
  readonly scope: string;
  // The asset's registry name, whose treasury books the payment
  readonly asset: string;
  readonly settlement: MppSettlementRequest;
}

export interface MppRailOptions {
  readonly setup: MppSetup;
  readonly recorder: PaymentRecorder;
  readonly ledger: SettlementLedger;
  readonly logger: Logger;
  // Whether a transaction has expired (CK-5)
  readonly clock: Clock;
  // The broadcast's timeout, as settle's (PR-12)
  readonly settleTimeoutMs: number;
}

const mppOnly = (authorization: Authorization): MppAuthorization => {
  if (authorization.rail !== 'mpp' || !('credential' in authorization))
    throw new TypeError(`The MPP rail can't take a ${authorization.rail} authorization`);

  return authorization as MppAuthorization;
};

// mppx's own refusal, first line only: its details are the buyer's own payment
const reasonOf = (error: Errors.PaymentError): string => error.message.split('\n', 1)[0]!.slice(0, reasonLength);

// The validated payment's signed transaction, in pull mode only
const pulledTransaction = (validated: unknown): { readonly serialized: Hex; readonly sender: Address } => {
  const details = isRecord(validated) ? validated['details'] : undefined;
  if (!isRecord(details) || details['mode'] !== 'pull' || typeof details['serializedTransaction'] !== 'string' || typeof details['sender'] !== 'string')
    throw new PaymentInvalidError('MPP payments here are signed transactions in pull mode. A transaction you broadcast yourself isn\'t accepted.');

  return { serialized: details['serializedTransaction'] as Hex, sender: details['sender'] as Address };
};

/**
 * MPP (PR-9, PR-12): the Tempo charge in pull mode, charged after a billable answer like x402. The
 * challenge offers each Tempo asset at or above its minimum price (PR-3), bound to the canonical pay
 * URL. Authorize validates the credential, which moves nothing, claims its transaction in the shared
 * replay store, and records the payment as `verified` with the transaction hash. Finalize broadcasts,
 * waits for the receipt, and books it. Abort cancels: the transaction is never broadcast.
 */
export const createMppRail = ({ setup, recorder, ledger, logger, clock, settleTimeoutMs }: MppRailOptions): PaymentRail => {
  const offered = (quote: Quote): readonly MppAsset[] => setup.assets.filter(asset => asset.minPrice <= quote.priceMicroUsd);
  const chargeRequest = (asset: MppAsset, quote: Quote): MppChargeRequest => ({
    // Exact, and never below the price (CK-4)
    amount: formatUnits(usdToAtomic(quote.priceMicroUsd, { decimals: asset.decimals, rounding: 'ceil' }), asset.decimals),
    currency: asset.address,
    decimals: asset.decimals,
    recipient: setup.recipient,
    chainId: setup.chainId,
    supportedModes: ['pull'],
  });

  const validate = async (header: string, request: MppChargeRequest, scope: string, log: LogSink): Promise<unknown> => {
    try {
      return await setup.validator.validateCredential(header, { request, scope });
    }
    catch (error) {
      if (error instanceof Errors.PaymentError)
        throw new PaymentInvalidError(`The payment was refused: ${reasonOf(error)}`, { reason: reasonOf(error) });
      const failure = rpcFailure(error);
      // viem's short message only: its full message carries the signed transaction (L-9)
      if (failure === 'unavailable' || failure === 'pending') {
        log.warn({ reason: errorReason(error), network: setup.network }, 'The Tempo RPC didn\'t answer while an MPP payment was checked');
        throw new PaymentUnavailableError();
      }
      if (failure === 'refused')
        throw new PaymentInvalidError('The Tempo node refused the payment\'s transaction in simulation, such as for an insufficient balance', { reason: errorReason(error) });

      log.warn({ reason: errorReason(error), network: setup.network }, 'An MPP credential failed its check');
      throw new PaymentInvalidError('The MPP credential isn\'t a valid payment for this call', { reason: errorReason(error) });
    }
  };

  const authorize = async (header: string, quote: Quote): Promise<Omit<MppAuthorization, 'credential'>> => {
    const log = quote.log ?? logger;
    let challenge;
    try {
      challenge = Credential.deserialize(header).challenge;
    }
    catch {
      throw new PaymentInvalidError('Authorization: Payment isn\'t an MPP credential');
    }
    const currency = challenge.request['currency'];
    const asset = offered(quote).find(candidate => typeof currency === 'string' && isAddressEqual(candidate.address, currency as Address));
    if (!asset)
      throw new PaymentInvalidError('The payment doesn\'t match an option for this price. Request the resource again for the current options.');

    const request = chargeRequest(asset, quote);
    const { serialized, sender } = pulledTransaction(await validate(header, request, quote.resource, log));
    const transaction = Transaction.deserialize(serialized);
    // The hash of the canonical envelope, as the node derives it: known before the broadcast
    const transactionHash = keccak256(await Transaction.serialize(transaction as Parameters<typeof Transaction.serialize>[0]));
    const { validBefore } = transaction as { readonly validBefore?: number };
    if (typeof validBefore !== 'number')
      throw new PaymentInvalidError('The payment\'s transaction must expire: sign it with validBefore, as mppx\'s client does');
    if (validBefore * 1_000 <= clock.now().getTime())
      throw new PaymentInvalidError('The payment\'s transaction has expired. Request the resource again, and sign a new one.');

    // A credential works once, on every replica: claimed until both the challenge and the transaction expire
    const challengeExpires = Date.parse(challenge.expires ?? '');
    const claimUntil = Math.max(validBefore * 1_000, Number.isFinite(challengeExpires) ? challengeExpires : 0);
    let claimed: boolean;
    try {
      claimed = await Store.tryClaim(setup.store, authorizedKey(transactionHash), claimUntil);
    }
    catch (error) {
      log.error({ reason: errorReason(error) }, 'The MPP replay store failed');
      throw new PaymentUnavailableError();
    }
    if (!claimed)
      throw new PaymentInvalidError('This payment credential was already used. Request the resource again, and pay the new challenge.');

    const { subject } = quote;
    const atomicAmount = usdToAtomic(quote.priceMicroUsd, { decimals: asset.decimals, rounding: 'ceil' });
    await recorder.create({
      id: quote.paymentId,
      requestId: quote.requestId,
      kind: subject.kind,
      rail: 'mpp',
      buyerAccountId: undefined,
      keyId: undefined,
      sellerAccountId: subject.kind === 'service' ? subject.sellerAccountId : undefined,
      serviceId: subject.kind === 'service' ? subject.serviceId : undefined,
      routeKey: subject.kind === 'service' ? subject.routeKey : undefined,
      targetHost: subject.kind === 'routed' ? subject.targetHost : undefined,
      targetPath: subject.kind === 'routed' ? subject.targetPath : undefined,
      network: setup.network,
      asset: asset.address,
      atomicAmount,
      amount: quote.priceMicroUsd,
      status: 'verified',
      transactionHash,
    });

    return {
      rail: 'mpp',
      paymentId: quote.paymentId,
      amount: quote.priceMicroUsd,
      feeBps: quote.feeBps,
      buyer: `address:${setup.network}:${sender.toLowerCase()}`,
      receipt: undefined,
      network: setup.network,
      ...quote.log ? { log: quote.log } : {},
      request,
      scope: quote.resource,
      asset: asset.name,
      settlement: {
        rail: 'mpp',
        transactionHash,
        validBefore,
        currency: asset.address,
        sender,
        recipient: setup.recipient,
        amount: atomicAmount.toString(),
      },
    };
  };

  // Whether a failed broadcast certainly charged nothing: refused before or by the node, or reverted
  const refused = (error: unknown): boolean => {
    if (error instanceof Errors.PaymentError)
      return true;
    if (error instanceof Error && error.message.startsWith('Transaction reverted'))
      return true;

    return rpcFailure(error) === 'refused';
  };

  return {
    name: 'mpp',
    settlesBeforeResponse: true,
    detect: detectMpp,
    challenge: async quote => {
      const assets = offered(quote);
      if (assets.length === 0)
        return undefined;

      const challenges = await Promise.all(assets.map(asset => setup.validator.challenge.tempo.charge({
        ...chargeRequest(asset, quote),
        description: quote.description,
        scope: quote.resource,
      })));

      return { headers: { 'www-authenticate': challenges.map(challenge => Challenge.serialize(challenge)).join(', ') } };
    },
    authorize: async (credential: RailCredential, quote) => {
      if (credential.rail !== 'mpp')
        throw new TypeError(`The MPP rail can't take a ${credential.rail} credential`);
      try {
        const authorization: MppAuthorization = { ...await authorize(credential.header.expose(), quote), credential: credential.header };

        return authorization;
      }
      catch (error) {
        credential.header.destroy();
        throw error;
      }
    },
    finalize: async (authorization): Promise<Receipt> => {
      const { paymentId, credential, request, scope, asset, feeBps, settlement, log = logger } = mppOnly(authorization);
      const { transactionHash: transaction } = settlement;
      let paid: MppReceipt.Receipt;
      try {
        const header = credential.expose();
        paid = await withTimeout(
          () => setup.broadcaster.broadcastCredential(header, { request, scope }),
          { timeoutMs: settleTimeoutMs },
        );
      }
      catch (error) {
        const reason = errorReason(error);
        const failed = refused(error);
        if (failed) {
          log.warn({ paymentId, reason, transaction, network: setup.network }, 'The MPP payment was refused or reverted. Nothing was charged.');
          await recorder.changeStatus({ paymentId, to: 'failed' });
        }
        else {
          // A timeout or a failed RPC call: the outcome is unknown. The follow-up reads the receipt (WK-6).
          log.warn({ paymentId, reason, transaction, network: setup.network }, 'The MPP broadcast\'s outcome is unknown. The settlement follow-up reads its receipt.');
          await recorder.changeStatus({ paymentId, to: 'settling', transactionHash: settlement.transactionHash, settlementRequest: toMppSettlementRequest(settlement) });
        }
        throw new SettlementFailedError({ outcome: failed ? 'failed' : 'unknown', reason, transaction, network: setup.network, cause: error });
      }
      finally {
        credential.destroy();
      }

      const receipt = MppReceipt.serialize(paid);
      await ledger.settle({ paymentId, feeBps, asset, transactionHash: paid.reference, receipt, needsReview: false });

      // Private: a shared cache must not serve one buyer's paid answer to another (PR-9)
      return { headers: { [paymentReceiptHeader]: receipt, 'cache-control': 'private' }, settlement: { status: 'settled', transaction: paid.reference } };
    },
    abort: async authorization => {
      const { paymentId, credential } = mppOnly(authorization);
      credential.destroy();
      await recorder.changeStatus({ paymentId, to: 'cancelled' });
    },
  };
};
