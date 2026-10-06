import { isRecord, usdToAtomic, type Logger } from '@servicerouter/common';
import type { JsonObject } from '@servicerouter/core';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import type { Network, PaymentPayload, PaymentRequirements, SettleResponse } from '@x402/core/types';

import { detectX402, type Credential } from '../credentials.js';
import { PaymentInvalidError, SettlementFailedError } from '../errors.js';
import type { PaymentRecorder, SettlementLedger } from '../ports.js';
import type { Authorization, PaymentRail, Quote, Receipt } from '../rail.js';
import type { X402Setup } from './setup.js';

// The header that carries the settle response to the buyer
export const paymentResponseHeader = 'payment-response';
// The x402 pending answer: broadcast, not final yet (PR-12)
export const settlementPending = 'settlement_pending';
const reasonPattern = /^[a-z0-9_]{1,64}$/;

/** What the x402 rail keeps between verify and settle. */
export interface X402Authorization extends Authorization {
  readonly rail: 'x402';
  readonly payload: PaymentPayload;
  readonly requirements: PaymentRequirements;
  // The asset's registry name, whose treasury books the payment
  readonly asset: string;
}

export interface X402RailOptions {
  readonly setup: X402Setup;
  readonly recorder: PaymentRecorder;
  readonly ledger: SettlementLedger;
  readonly logger: Logger;
}

/** What a worker repeats until a settlement is final (WK-6). */
export interface SettlementRequest {
  readonly paymentPayload: PaymentPayload;
  readonly paymentRequirements: PaymentRequirements;
}

export const toSettlementRequest = (payload: PaymentPayload, requirements: PaymentRequirements): JsonObject =>
  ({ paymentPayload: payload, paymentRequirements: requirements }) as unknown as JsonObject;

export const fromSettlementRequest = (value: JsonObject | undefined): SettlementRequest | undefined =>
  isRecord(value) && isRecord(value['paymentPayload']) && isRecord(value['paymentRequirements'])
    ? value as unknown as SettlementRequest
    : undefined;

/** A settle response as the `PAYMENT-RESPONSE` header carries it to the buyer. */
export const encodeSettleReceipt = (result: SettleResponse): string => encodePaymentResponseHeader(result);

const x402Only = (authorization: Authorization): X402Authorization => {
  if (authorization.rail !== 'x402' || !('payload' in authorization))
    throw new TypeError(`The x402 rail can't take a ${authorization.rail} authorization`);

  return authorization as X402Authorization;
};

const decode = (credential: Credential): PaymentPayload => {
  if (credential.rail !== 'x402')
    throw new TypeError(`The x402 rail can't take a ${credential.rail} credential`);
  try {
    if (credential.version !== 2)
      throw new PaymentInvalidError('x402 v1 (X-PAYMENT) isn\'t accepted. Pay with PAYMENT-SIGNATURE (x402 v2).');

    let payload: unknown;
    try {
      payload = decodePaymentSignatureHeader(credential.header.expose());
    }
    catch {
      throw new PaymentInvalidError('PAYMENT-SIGNATURE isn\'t an x402 payment: base64 of its JSON');
    }
    if (!isRecord(payload) || payload['x402Version'] !== 2 || !isRecord(payload['accepted']) || !isRecord(payload['payload']))
      throw new PaymentInvalidError('PAYMENT-SIGNATURE isn\'t an x402 v2 payment');

    return payload as unknown as PaymentPayload;
  }
  finally {
    credential.header.destroy();
  }
};

/**
 * x402 (PR-5, PR-12): requirements per request from the quote, with the SDK's resource server, one
 * `exact` option per offered asset at or above its minimum price (PR-3). Verifies through the
 * network's facilitator before forwarding, and records the payment as `verified`. Settles after a
 * billable response, before any byte goes out, and books it. Otherwise cancels: nothing settles.
 */
export const createX402Rail = ({ setup, recorder, ledger, logger }: X402RailOptions): PaymentRail => {
  const { server } = setup;

  // The same quote gives the same requirements, so the paid retry matches what the 402 offered
  const requirementsFor = async (quote: Quote): Promise<PaymentRequirements[]> => {
    const offered = setup.assets.filter(asset => asset.minPrice <= quote.priceMicroUsd);
    const lists = await Promise.all(offered.map(asset => server.buildPaymentRequirements({
      scheme: 'exact',
      network: asset.network as Network,
      payTo: asset.payTo,
      // Exact, and never below the price (CK-4)
      price: { amount: usdToAtomic(quote.priceMicroUsd, { decimals: asset.decimals, rounding: 'ceil' }).toString(), asset: asset.address, extra: { ...asset.extra } },
    })));

    return lists.flat();
  };

  const settlementFailed = async (paymentId: string, to: 'failed' | 'settling', request?: JsonObject): Promise<never> => {
    await recorder.changeStatus({ paymentId, to, ...(request ? { settlementRequest: request } : { settlementRequest: null }) });
    throw new SettlementFailedError();
  };

  return {
    name: 'x402',
    settlesBeforeResponse: true,
    detect: detectX402,
    challenge: async quote => {
      const accepts = await requirementsFor(quote);
      if (accepts.length === 0)
        return undefined;

      const required = await server.createPaymentRequiredResponse(accepts, { url: quote.resource, description: quote.description }, 'Payment required');

      return { headers: { 'payment-required': encodePaymentRequiredHeader(required) }, body: { ...required } };
    },
    authorize: async (credential, quote) => {
      const payload = decode(credential);
      const requirements = server.findMatchingRequirements(await requirementsFor(quote), payload);
      if (!requirements)
        throw new PaymentInvalidError('The payment doesn\'t match an option for this price. Request the resource again for the current options.');
      const asset = setup.assetName(requirements.network, requirements.asset);
      if (!asset)
        throw new PaymentInvalidError('The payment\'s asset isn\'t offered');

      const verified = await server.verifyPayment(payload, requirements);
      if (!verified.isValid) {
        const reason = verified.invalidReason && reasonPattern.test(verified.invalidReason) ? `: ${verified.invalidReason}` : '';
        throw new PaymentInvalidError(`The facilitator rejected the payment${reason}`);
      }

      const { subject } = quote;
      await recorder.create({
        id: quote.paymentId,
        requestId: quote.requestId,
        kind: subject.kind,
        rail: 'x402',
        buyerAccountId: undefined,
        keyId: undefined,
        sellerAccountId: subject.kind === 'service' ? subject.sellerAccountId : undefined,
        serviceId: subject.kind === 'service' ? subject.serviceId : undefined,
        routeKey: subject.kind === 'service' ? subject.routeKey : undefined,
        targetHost: subject.kind === 'routed' ? subject.targetHost : undefined,
        targetPath: subject.kind === 'routed' ? subject.targetPath : undefined,
        network: requirements.network,
        asset: requirements.asset,
        atomicAmount: BigInt(requirements.amount),
        amount: quote.priceMicroUsd,
        status: 'verified',
      });
      const authorization: X402Authorization = {
        rail: 'x402',
        paymentId: quote.paymentId,
        amount: quote.priceMicroUsd,
        feeBps: quote.feeBps,
        buyer: `address:${requirements.network}:${verified.payer ?? 'unknown'}`,
        receipt: undefined,
        payload,
        requirements,
        asset,
      };

      return authorization;
    },
    finalize: async (authorization): Promise<Receipt> => {
      const { paymentId, payload, requirements, asset, feeBps } = x402Only(authorization);
      const request = toSettlementRequest(payload, requirements);
      let result: SettleResponse;
      try {
        result = await server.settlePayment(payload, requirements);
      }
      catch (error) {
        // A timeout or a 503: the outcome is unknown. The worker repeats it (PR-12).
        logger.warn({ error, paymentId }, 'The settlement\'s outcome is unknown. The settlement follow-up repeats it.');
        return settlementFailed(paymentId, 'settling', request);
      }

      if (result.success) {
        const receipt = encodePaymentResponseHeader(result);
        await ledger.settle({ paymentId, feeBps, asset, transactionHash: result.transaction || undefined, receipt, needsReview: false });

        return { headers: { [paymentResponseHeader]: receipt } };
      }
      if (result.errorReason === settlementPending && result.transaction) {
        // Broadcast, not final: the response goes out, and the worker finishes the settlement
        const receipt = encodePaymentResponseHeader(result);
        await recorder.changeStatus({ paymentId, to: 'settling', transactionHash: result.transaction, receipt, settlementRequest: request });

        return { headers: { [paymentResponseHeader]: receipt } };
      }

      logger.warn({ paymentId, reason: result.errorReason }, 'The settlement failed. Nothing was charged.');
      return settlementFailed(paymentId, 'failed');
    },
    abort: async authorization => {
      await recorder.changeStatus({ paymentId: x402Only(authorization).paymentId, to: 'cancelled' });
    },
  };
};
