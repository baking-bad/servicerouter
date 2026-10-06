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

/** The Ledger refused the hold: the balance, the daily budget, or the allowance (LG-6, AK-7). */
export class HoldRefusedError extends ServiceRouterError {
  readonly code: HoldRefusal;

  constructor(refusal: HoldRefusal) {
    super(refusalMessages[refusal]);

    this.code = refusal;
  }
}
