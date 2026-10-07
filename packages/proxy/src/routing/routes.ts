import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  formatUsd, isRecord, OutboundHttpError, outboundFields, OwnHostError, upstreamRequestIdOf, type Clock, type Logger, type LogSink, type MicroUsd, type OutboundHttp,
  type OutboundResponse,
} from '@servicerouter/common';
import { findAsset, type PlatformConfig } from '@servicerouter/core';
import type { Ledger, Redis, RoutingRepository } from '@servicerouter/db';
import {
  chooseOption, HostNotAllowedError, mppRefusals, NotPayableError, parseRoutingTarget, parseTargetChallenge, QuoteExceededError, routingQuote, solanaRefusals,
  targetReceipt, UnsupportedPaymentError, type ChosenOption, type RoutingTarget, type TargetChallenge,
} from '@servicerouter/payments';
import type { PaymentRequirements } from '@x402/core/types';

import { UpstreamUnavailableError } from '../errors.js';
import type { PaidCall, PaymentStep } from '../payments/step.js';
import { filterResponseHeaders } from '../services/forward.js';
import {
  isOwnHost, ownDomainsOf, routedRequestHeaders, SignerUnavailableError, type EndpointRegistrar, type SignerClient,
} from './support.js';

// RT-5: a quote is reused for this long, so a repeat call skips the probe
export const quoteTtlSeconds = 30;
// An MPP quote leaves the cache this long before its challenge expires, so the Signer never gets an expired one
const challengeMarginSeconds = 10;
// The probe's 402 body is small: options, never content
const challengeBodyLimit = 64 * 1024;
// The target's payment headers, which never reach the buyer (RT-10)
const targetPaymentHeaders = new Set(['payment-required', 'payment-response', 'www-authenticate', 'x-payment-response', 'payment-receipt']);

export interface RoutingOptions {
  readonly config: PlatformConfig;
  readonly http: Pick<OutboundHttp, 'request'>;
  readonly redis: Redis;
  readonly payments: PaymentStep;
  readonly routing: Pick<RoutingRepository, 'isBlocked' | 'isServiceHost' | 'endpointFee' | 'recordTargetPayment' | 'updateTargetPayment'>;
  readonly ledger: Pick<Ledger, 'routingLoss'>;
  readonly signer: SignerClient | undefined;
  readonly optedOut: (host: string, log?: LogSink) => Promise<boolean>;
  readonly registrar: EndpointRegistrar;
  // The per-IP limit of the link checker (RT-19)
  readonly limitIp: (ip: string) => Promise<void>;
  // Whether an MPP challenge has expired (CK-5)
  readonly clock: Clock;
  readonly logger: Logger;
}

/** A target's price and our quote (RT-4, RT-5), as cached: an x402 option or an MPP challenge. */
type RoutingQuote = {
  readonly network: string;
  readonly asset: string;
  readonly price: MicroUsd;
  readonly fee: MicroUsd;
  readonly quote: MicroUsd;
} & ({
  readonly protocol: 'x402';
  readonly x402Version: number;
  readonly requirement: PaymentRequirements;
  readonly resource: unknown;
} | {
  readonly protocol: 'mpp';
  // The target's `WWW-Authenticate: Payment` challenge, as it sent it
  readonly challenge: string;
});

// What the target offered, for the log when we can pay none of it (L-5): scheme and network only, and the MPP challenges' methods
const offeredOptions = (challenge: TargetChallenge | undefined): string[] => [
  ...(challenge?.accepts ?? []).slice(0, 10)
    .map(option => isRecord(option) ? `${String(option['scheme']).slice(0, 32)} ${String(option['network']).slice(0, 64)}` : 'invalid'),
  ...(challenge?.mpp ?? []).slice(0, 10).map(item => `mpp ${item.method.slice(0, 32)}.${item.intent.slice(0, 32)}`),
];

/** A quote's fields on a log line (L-5): the protocol and option chosen, the target's price, the fee, and our quote. */
const quoteFields = (quote: RoutingQuote): Record<string, string | number> => ({
  protocol: quote.protocol,
  network: quote.network,
  asset: quote.asset,
  ...quote.protocol === 'x402' ? { x402Version: quote.x402Version } : {},
  price: formatUsd(quote.price),
  fee: formatUsd(quote.fee),
  quote: formatUsd(quote.quote),
});

const serializeQuote = (quote: RoutingQuote): string => JSON.stringify({ ...quote, price: quote.price.toString(), fee: quote.fee.toString(), quote: quote.quote.toString() });
const parseQuote = (text: string): RoutingQuote => {
  const value = JSON.parse(text) as RoutingQuote & { price: string; fee: string; quote: string };
  const amounts = { price: BigInt(value.price) as MicroUsd, fee: BigInt(value.fee) as MicroUsd, quote: BigInt(value.quote) as MicroUsd };

  // A quote cached before MPP routing is an x402 one, without its protocol or network
  return value.protocol === 'mpp'
    ? { ...value, ...amounts }
    : { ...value, protocol: 'x402', network: value.network ?? value.requirement.network, ...amounts };
};

/** How long a quote stays cached (RT-5): an MPP quote until shortly before its challenge expires, and never one bound to a body. */
const cacheSecondsOf = (chosen: ChosenOption, now: Date): number => {
  if (chosen.protocol === 'x402')
    return quoteTtlSeconds;
  if (chosen.bindsBody)
    return 0;
  const expires = chosen.expires === undefined ? Number.NaN : Date.parse(chosen.expires);

  return Number.isFinite(expires) ? Math.min(quoteTtlSeconds, Math.floor((expires - now.getTime()) / 1_000) - challengeMarginSeconds) : quoteTtlSeconds;
};

/** Payment routing (RT-1 to RT-19): `/<host>/<path>` pays any x402 or MPP API for the buyer, and `GET /_/check` quotes one. */
export const createRouting = ({ config, http, redis, payments, routing, ledger, signer, optedOut, registrar, limitIp, clock }: RoutingOptions) => {
  const payUrl = config.urls.pay.replace(/\/+$/, '');
  const ownDomains = ownDomainsOf(config);

  // L-5: why a host is refused, at info: the buyer picked it
  const refuseHost = (log: LogSink, target: RoutingTarget, reason: string, message?: string): never => {
    log.info({ host: target.host, code: 'host_not_allowed', reason }, 'Routing refused the host');
    throw new HostNotAllowedError(...message === undefined ? [] : [message]);
  };

  /** RT-2: our hosts, sellers' hosts, blocklisted hosts, and hosts that opted out. */
  const checkHost = async (target: RoutingTarget, log: LogSink): Promise<void> => {
    if (isOwnHost(target.hostname, ownDomains))
      refuseHost(log, target, 'own_host');
    const [service, blocked, optOut] = await Promise.all([
      routing.isServiceHost(target.hostname), routing.isBlocked(target.hostname), optedOut(target.hostname, log),
    ]);
    if (service)
      refuseHost(log, target, 'service_host', 'This host serves a registered service: call it at its service URL');
    if (blocked)
      refuseHost(log, target, 'blocklisted');
    if (optOut)
      refuseHost(log, target, 'opted_out');
  };

  // `attempt`: 1 for the probe, 2 for the paid retry
  const send = async (
    target: RoutingTarget, method: string, headers: Record<string, string | readonly string[]>, body: Buffer | undefined, log: LogSink, attempt: number,
  ): Promise<OutboundResponse> => {
    const started = performance.now();
    try {
      return await http.request({ url: target.url, method, headers, body, redirect: 'none' });
    }
    catch (error) {
      const fields = outboundFields({ url: target.url, method, error, durationMs: performance.now() - started, attempt });
      // OH-5: a host that resolves to our addresses
      if (error instanceof OwnHostError)
        return refuseHost(log, target, 'own_address');
      // L-4: the address policy and the transport say why, at warn
      if (error instanceof OutboundHttpError) {
        log.warn({ ...fields, error }, 'The routed target couldn\'t be reached');
        throw new UpstreamUnavailableError();
      }
      throw error;
    }
  };

  /** RT-3 to RT-5: the probe, the option, and the quote, cached by method and URL. */
  const quoteFor = async (
    target: RoutingTarget, method: string, headers: Record<string, string | readonly string[]>, body: Buffer | undefined, log: LogSink,
  ): Promise<RoutingQuote> => {
    const key = `${redis.prefix}quote:${method} ${target.url}`;
    try {
      const cached = await redis.client.get(key);
      if (cached !== null) {
        const quote = parseQuote(cached);
        log.debug({ host: target.host, path: target.path, ...quoteFields(quote), cached: true }, 'Routing quote');

        return quote;
      }
    }
    catch (error) {
      log.warn({ error }, 'The quote cache is unavailable');
    }

    const started = performance.now();
    const response = await send(target, method, headers, body, log, 1);
    const probe = { host: target.host, path: target.path, targetStatus: response.status, targetRequestId: upstreamRequestIdOf(response.headers), durationMs: Math.round(performance.now() - started) };
    // L-5: the probe's outcome
    if (response.status !== 402) {
      response.dispose();
      log.info({ ...probe, code: 'not_payable' }, 'The routed target didn\'t ask for a payment');
      throw new NotPayableError();
    }
    let challengeBody: Buffer;
    try {
      challengeBody = (await response.bytes()).subarray(0, challengeBodyLimit);
    }
    catch {
      challengeBody = Buffer.alloc(0);
    }
    const challenge = parseTargetChallenge(response.headers, challengeBody);
    const now = clock.now();
    const chosen = challenge && chooseOption(challenge, config, now);
    if (!challenge || !chosen) {
      // L-5: and why each MPP challenge or Solana option isn't payable, such as push_only, splits, or no_fee_payer
      const refusals = challenge ? [...mppRefusals(challenge, config, now), ...solanaRefusals(challenge, config)] : [];
      log.info({
        ...probe, code: 'unsupported_payment', offered: offeredOptions(challenge), ...refusals.length > 0 ? { reasons: [...new Set(refusals)] } : {},
      }, 'The routed target offers no payment we make');
      throw new UnsupportedPaymentError();
    }

    const feeBps = await routing.endpointFee(target.host, target.path) ?? config.routingFeeBps;
    const { quote, fee } = routingQuote(chosen.price, feeBps);
    const amounts = { network: chosen.asset.network.id, asset: chosen.asset.name, price: chosen.price, fee, quote };
    const result: RoutingQuote = chosen.protocol === 'x402'
      ? { protocol: 'x402', x402Version: challenge.x402Version, requirement: chosen.requirement, resource: challenge.resource, ...amounts }
      : { protocol: 'mpp', challenge: chosen.challenge, ...amounts };
    // L-5: the option chosen and the quote
    log.info({ ...probe, ...quoteFields(result), cached: false }, 'Routing quote');
    const cacheSeconds = cacheSecondsOf(chosen, now);
    try {
      if (cacheSeconds > 0)
        await redis.client.set(key, serializeQuote(result), { expiration: { type: 'EX', value: cacheSeconds } });
    }
    catch (error) {
      log.warn({ error }, 'Failed to cache a quote');
    }

    return result;
  };

  // RT-10: the target's links to itself point at the routing link; payment headers stay out
  const responseHeaders = (target: RoutingTarget, response: OutboundResponse): Record<string, string | string[]> => {
    const own = `https://${target.host}`;
    const headers = filterResponseHeaders(response.headers, value => {
      try {
        const url = new URL(value, target.url);

        return url.origin === own ? `${payUrl}/${target.host}${url.pathname}${url.search}` : value;
      }
      catch {
        return undefined;
      }
    });

    return Object.fromEntries(Object.entries(headers).filter(([name]) => !targetPaymentHeaders.has(name)));
  };

  const serve = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const log = request.log;
    const target = parseRoutingTarget(request.raw.url ?? '/');
    await checkHost(target, log);
    const headers = routedRequestHeaders(request.headers, request.id);
    const body = request.body as Buffer | undefined;
    const quoted = await quoteFor(target, request.method, headers, body, log);

    // RT-6: the buyer pays the quote, with a key, x402, or MPP; or gets the combined 402 at it
    const payment = await payments.beginRouted({
      headers: request.headers, ip: request.ip, log, requestId: request.id, host: target.host, path: target.path,
      resource: `${payUrl}/${target.host}${target.path}`, quote: quoted.quote,
    });
    if (payment.kind === 'challenge')
      return reply.status(payment.response.status).headers(payment.response.headers).send(payment.response.body);

    const call: PaidCall = payment.call;
    const { paymentId } = call.authorization;
    const abortBuyer = async (status: number | undefined): Promise<void> => {
      await payments.finish(call, await payments.decide(call, { status, latencyMs: 0 }));
    };
    const leg = { paymentId, host: target.host, path: target.path, ...quoteFields(quoted) };

    // RT-7: pay the target only now, through the Signer, within the quote (SG-3)
    if (!signer) {
      log.warn(leg, 'Payment routing pays no targets: no Signer is configured');
      await abortBuyer(undefined);
      throw new UpstreamUnavailableError();
    }
    let signed;
    try {
      const option = quoted.protocol === 'x402'
        ? { protocol: 'x402' as const, x402Version: quoted.x402Version, requirement: quoted.requirement, resource: quoted.resource }
        : { protocol: 'mpp' as const, challenge: quoted.challenge };
      signed = await signer.sign({ requestId: request.id, quoteId: paymentId, ...option, url: target.url, quotedPrice: quoted.price });
    }
    catch (error) {
      await abortBuyer(undefined);
      if (error instanceof SignerUnavailableError) {
        // L-5: the Signer's refusal reason from 422 signing_refused, or why it couldn't be reached (L-4)
        const { failure } = error;
        log.warn({
          ...leg, signer: failure, ...failure?.code === undefined ? {} : { code: failure.code }, ...failure?.reason === undefined ? {} : { reason: failure.reason },
          ...error.cause === undefined ? {} : { error: error.cause },
        }, 'The Signer didn\'t sign a routed payment');
        throw new UpstreamUnavailableError();
      }
      throw error;
    }
    // RT-11: the target leg, recorded before the payment goes out
    await routing.recordTargetPayment({
      paymentId, protocol: quoted.protocol, network: signed.network, asset: signed.asset, amount: signed.amount, atomicAmount: signed.atomicAmount,
      payTo: signed.payTo, signatureId: signed.signatureId,
    });

    // Our payment, never the buyer's own Authorization (RT-16). An MPP transaction expires within about 25 s: sent now.
    const paymentHeader = quoted.protocol === 'mpp' ? 'authorization' : quoted.x402Version >= 2 ? 'payment-signature' : 'x-payment';
    const signedLeg = { ...leg, signatureId: signed.signatureId, payTo: signed.payTo };
    const started = performance.now();
    let response: OutboundResponse;
    try {
      response = await send(target, request.method, { ...headers, [paymentHeader]: signed.header }, body, log, 2);
    }
    catch (error) {
      // Unknown: the target may have the signed authorization. The buyer isn't charged; the leg stays unknown.
      log.warn({ ...signedLeg, targetLeg: 'unknown' }, 'The routed target didn\'t answer the paid retry: its payment\'s outcome is unknown');
      await routing.updateTargetPayment(paymentId, { status: 'unknown' });
      await abortBuyer(undefined);
      throw error;
    }
    const latencyMs = Math.round(performance.now() - started);
    const answered = { ...signedLeg, targetStatus: response.status, targetRequestId: upstreamRequestIdOf(response.headers), durationMs: latencyMs, attempt: 2 };

    // RT-8: a retry that asks for more than the quote is refused; the buyer isn't charged
    if (response.status === 402) {
      const challenge = parseTargetChallenge(response.headers, (await response.bytes().catch(() => Buffer.alloc(0))).subarray(0, challengeBodyLimit));
      const again = challenge && chooseOption(challenge, config, clock.now());
      await routing.updateTargetPayment(paymentId, { status: 'failed' });
      await abortBuyer(402);
      await redis.client.del(`${redis.prefix}quote:${request.method} ${target.url}`).catch(() => undefined);
      const exceeded = again !== undefined && again.price > quoted.price;
      log.warn({
        ...answered, receipt: false, code: exceeded ? 'quote_exceeded' : 'upstream_unavailable', ...again ? { askedPrice: formatUsd(again.price) } : {},
      }, 'The routed target refused our payment on the paid retry');
      if (exceeded)
        throw new QuoteExceededError();
      throw new UpstreamUnavailableError();
    }

    // RT-9, RT-11: its PAYMENT-RESPONSE or Payment-Receipt, and the transaction it names
    const settled = targetReceipt(response.headers);
    const receipt = settled && { receipt: settled.receipt, ...settled.transaction === undefined ? {} : { transactionHash: settled.transaction } };
    // L-5: the target's status, and whether it returned a receipt. A target's 5xx is an expected outcome: info.
    log.info({ ...answered, receipt: receipt !== undefined }, 'Routed call answered');
    response.body.on('error', () => undefined);
    const decision = await payments.decide(call, { status: response.status, latencyMs, upstreamRequestId: answered.targetRequestId });
    const answerHeaders = responseHeaders(target, response);
    const bodyless = request.method === 'HEAD' || response.status === 204 || response.status === 304;
    if (decision !== 'billable') {
      // RT-9: not charged. If the target kept our payment anyway, it's a routing loss.
      await payments.finish(call, decision);
      if (receipt) {
        await routing.updateTargetPayment(paymentId, { status: 'settled', ...receipt });
        await ledger.routingLoss({ paymentId });
        log.warn({
          paymentId, host: target.host, status: response.status, protocol: quoted.protocol, network: signed.network, amount: formatUsd(signed.amount), asset: signed.asset,
        }, 'A target kept a routed payment for a failed call: booked as a routing loss');
      }
      else
        await routing.updateTargetPayment(paymentId, { status: 'failed' });
      // PX-7: a server error is opaque
      if (response.status >= 500) {
        response.dispose();
        throw new UpstreamUnavailableError();
      }
      reply.status(response.status).headers(answerHeaders);

      return bodyless ? (response.dispose(), reply.send()) : reply.send(response.body);
    }

    await routing.updateTargetPayment(paymentId, { status: 'settled', ...receipt });
    registrar.register(target.host, target.path, quoted.quote, request.id);
    if (call.rail.settlesBeforeResponse) {
      // x402 and MPP buyers: settle before any byte goes out (PX-12)
      const buffered = bodyless ? undefined : await response.bytes();
      if (bodyless)
        response.dispose();
      let buyerReceipt;
      try {
        buyerReceipt = await payments.settleNow(call);
      }
      catch (error) {
        // The target is paid and the buyer isn't: the workers book the routing loss once the buyer's
        // payment is final (RT-9). The owner accepts this risk for the MVP, capped by the Signer's limits.
        log.warn({ error, paymentId, host: target.host, rail: call.rail.name, amount: formatUsd(signed.amount), asset: signed.asset },
          'A routed buyer\'s settlement failed after the target was paid');
        throw error;
      }

      return reply.status(response.status).headers({ ...answerHeaders, ...buyerReceipt.headers }).send(buffered);
    }
    reply.raw.once('close', () => {
      void payments.finish(call, decision);
    });
    reply.status(response.status).headers({ ...answerHeaders, ...call.authorization.receipt?.headers });

    return bodyless ? (response.dispose(), reply.send()) : reply.send(response.body);
  };

  /** RT-19: the link checker's endpoint: is the link payable, at what price, and our quote, without paying. */
  const check = async (request: FastifyRequest<{ Querystring: { readonly url?: string } }>): Promise<Record<string, unknown>> => {
    await limitIp(request.ip);
    const link = request.query.url ?? '';
    let parsed: URL;
    try {
      parsed = new URL(link.includes('://') ? link : `https://${link}`);
    }
    catch {
      return { payable: false, reason: 'invalid_target', message: 'The link isn\'t a URL' };
    }
    try {
      const target = parseRoutingTarget(`/${parsed.host}${parsed.pathname}${parsed.search}`);
      await checkHost(target, request.log);
      const quoted = await quoteFor(target, 'GET', routedRequestHeaders({}, request.id), undefined, request.log);
      const asset = findAsset(config, quoted.asset);

      return {
        payable: true,
        target: target.url,
        price: { amount: formatUsd(quoted.price), currency: 'USD', asset: quoted.asset, network: asset?.network.id ?? null },
        quote: { amount: formatUsd(quoted.quote), fee: formatUsd(quoted.fee), currency: 'USD' },
        link: `${payUrl}/${target.host}${target.path}${target.search}`,
      };
    }
    catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && ['invalid_target', 'host_not_allowed', 'not_payable', 'unsupported_payment', 'upstream_unavailable'].includes(code))
        return { payable: false, reason: code, message: (error as Error).message };
      throw error;
    }
  };

  return { serve, check };
};
