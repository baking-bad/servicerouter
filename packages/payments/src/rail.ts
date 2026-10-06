import type { LogSink, MicroUsd } from '@servicerouter/common';
import type { RailName } from '@servicerouter/core';

import type { Credential } from './credentials.js';

/** Request headers as Node gives them: lowercase names. */
export type RequestHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * What a paid call is for, recorded on its payment row (LG-7). A rail never branches on it: only the
 * quote differs between a registered and a routed call (PR-11).
 */
export type PaymentSubject =
  | {
    readonly kind: 'service';
    readonly serviceId: string;
    readonly routeKey: string | undefined;
    // The service's owner, who earns from the call
    readonly sellerAccountId: string;
  }
  | {
    readonly kind: 'routed';
    readonly targetHost: string;
    readonly targetPath: string;
  };

/** The price of one call, and everything a rail records about it. */
export interface Quote {
  readonly paymentId: string;
  readonly requestId: string | undefined;
  // The canonical pay URL of the resource (PX-10)
  readonly resource: string;
  readonly priceMicroUsd: MicroUsd;
  readonly description: string;
  readonly subject: PaymentSubject;
  // The platform's share, taken at capture or settlement (LG-4)
  readonly feeBps: number;
  // The request's logger, so a rail's lines carry the request ID (XC-5, L-3). Default: the rail's own.
  readonly log?: LogSink;
}

/** One rail's part of the combined `402` (PR-2): headers, and fields of the JSON body. */
export interface ChallengePart {
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, unknown>>;
}

/** Headers that tell the buyer what was paid (PX-6), such as `Servicerouter-Receipt` (AR2). */
export interface Receipt {
  readonly headers: Readonly<Record<string, string>>;
  // What an on-chain settlement did, for the log (L-3): settled, or broadcast and still settling
  readonly settlement?: { readonly status: 'settled' | 'settling'; readonly transaction: string | undefined };
}

/** An authorized payment: what a rail finalizes after a billable response, or aborts otherwise. */
export interface Authorization {
  readonly rail: RailName;
  readonly paymentId: string;
  readonly amount: MicroUsd;
  readonly feeBps: number;
  // Who pays, for the buyer header (PX-15): `account:<id>` for credits, the payer for x402 and MPP
  readonly buyer: string;
  // The receipt, when the rail knows it before finalizing. Credits responses stream (PX-12), so their
  // receipt goes out with the response headers, before the capture.
  readonly receipt: Receipt | undefined;
  // For the log (L-3): the network and the asset's registry name an on-chain payment uses
  readonly network?: string;
  readonly asset?: string;
  // The request's logger, from the quote, for the lines finalize and abort write
  readonly log?: LogSink;
}

/** A payment rail (PR-1 to PR-12). Credits from step 4, x402 from step 5, MPP from step 7. */
export interface PaymentRail {
  readonly name: RailName;
  /**
   * Whether the money must move before any upstream byte reaches the buyer (PX-12): x402 settles,
   * then sends the buffered response. Otherwise the response streams and `finalize` runs after it.
   */
  readonly settlesBeforeResponse: boolean;
  /** This rail's credential in the request, or undefined. */
  detect(headers: RequestHeaders): Credential | undefined;
  /** Its part of the combined `402`, or undefined when it can't take this quote. */
  challenge(quote: Quote): Promise<ChallengePart | undefined>;
  /** Checks the credential against the quote and reserves the money. Throws a coded error when refused. */
  authorize(credential: Credential, quote: Quote): Promise<Authorization>;
  /** Takes the money after a billable response. Running it twice moves money once. */
  finalize(authorization: Authorization): Promise<Receipt>;
  /** Gives the reservation back after a response that isn't billable. Running it twice moves money once. */
  abort(authorization: Authorization): Promise<void>;
}
