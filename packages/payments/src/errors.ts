import { ServiceRouterError } from '@servicerouter/common';
import type { HoldRefusal } from '@servicerouter/core';

/** Two or more payment credentials in one request (PR-1). */
export class MultiplePaymentMethodsError extends ServiceRouterError {
  readonly code = 'multiple_payment_methods';

  constructor() {
    super('Send exactly one payment credential: a payment key, an x402 payment, or an MPP credential');
  }
}

/** The price is above the payment key's maximum per call (AK-6, PR-4). */
export class KeyPriceLimitError extends ServiceRouterError {
  readonly code = 'key_price_limit';

  constructor() {
    super('The price is above the payment key\'s maximum per call');
  }
}

const refusalMessages: Readonly<Record<HoldRefusal, string>> = {
  insufficient_balance: 'The credits balance doesn\'t cover the price',
  key_budget_exceeded: 'The payment key\'s daily budget doesn\'t cover the price',
  key_allowance_exceeded: 'The payment key\'s allowance doesn\'t cover the price',
};

/** The x402 payment isn't one this call takes, or the facilitator rejected it (PR-5). Nothing moved. */
export class PaymentInvalidError extends ServiceRouterError {
  readonly code = 'payment_invalid';
}

/**
 * An MPP payment couldn't be checked before forwarding: the Tempo RPC didn't answer, or the replay
 * store is down (PR-9). Nothing was paid, and the upstream wasn't called.
 */
export class PaymentUnavailableError extends ServiceRouterError {
  readonly code = 'payment_unavailable';

  constructor() {
    super('The payment couldn\'t be checked right now. Nothing was paid. Retry the request.');
  }
}

/**
 * The settlement failed, or its outcome is unknown, so the response isn't sent (PR-12). A failure
 * charges nothing. An unknown outcome is repeated by a worker, which flags it for review if it settles.
 */
export class SettlementFailedError extends ServiceRouterError {
  readonly code = 'settlement_failed';

  constructor() {
    super('The payment couldn\'t be settled, so the response wasn\'t sent. Retry the request.');
  }
}

/** The Ledger refused the hold: the balance, the daily budget, or the allowance (LG-6, AK-7). */
export class HoldRefusedError extends ServiceRouterError {
  readonly code: HoldRefusal;

  constructor(refusal: HoldRefusal) {
    super(refusalMessages[refusal]);

    this.code = refusal;
  }
}
