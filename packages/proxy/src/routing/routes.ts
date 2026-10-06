import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { formatUsd, OutboundHttpError, OwnHostError, type Logger, type MicroUsd, type OutboundHttp, type OutboundResponse } from '@servicerouter/common';
import { findAsset, type PlatformConfig } from '@servicerouter/core';
import type { Ledger, Redis, RoutingRepository } from '@servicerouter/db';
import {
  chooseOption, HostNotAllowedError, NotPayableError, parseRoutingTarget, parseTargetChallenge, QuoteExceededError, routingQuote,
  UnsupportedPaymentError, type RoutingTarget,
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
  readonly optedOut: (host: string) => Promise<boolean>;
  readonly registrar: EndpointRegistrar;
  // The per-IP limit of the link checker (RT-19)
  readonly limitIp: (ip: string) => Promise<void>;
  readonly logger: Logger;
}

/** A target's price and our quote (RT-4, RT-5), as cached. */
interface RoutingQuote {
  readonly x402Version: number;
  readonly requirement: PaymentRequirements;
  readonly resource: unknown;
  readonly asset: string;
  readonly price: MicroUsd;
  readonly fee: MicroUsd;
  readonly quote: MicroUsd;
}

const serializeQuote = (quote: RoutingQuote): string => JSON.stringify({ ...quote, price: quote.price.toString(), fee: quote.fee.toString(), quote: quote.quote.toString() });
const parseQuote = (text: string): RoutingQuote => {
  const value = JSON.parse(text) as RoutingQuote & { price: string; fee: string; quote: string };

  return { ...value, price: BigInt(value.price) as MicroUsd, fee: BigInt(value.fee) as MicroUsd, quote: BigInt(value.quote) as MicroUsd };
};

/** Payment routing (RT-1 to RT-19): `/<host>/<path>` pays any x402 API for the buyer, and `GET /_/check` quotes one. */
export const createRouting = ({ config, http, redis, payments, routing, ledger, signer, optedOut, registrar, limitIp, logger }: RoutingOptions) => {
  const payUrl = config.urls.pay.replace(/\/+$/, '');
  const ownDomains = ownDomainsOf(config);

  /** RT-2: our hosts, sellers' hosts, blocklisted hosts, and hosts that opted out. */
  const checkHost = async (target: RoutingTarget): Promise<void> => {
    if (isOwnHost(target.hostname, ownDomains))
      throw new HostNotAllowedError();
    const [service, blocked, optOut] = await Promise.all([
      routing.isServiceHost(target.hostname), routing.isBlocked(target.hostname), optedOut(target.hostname),
    ]);
    if (service)
      throw new HostNotAllowedError('This host serves a registered service: call it at its service URL');
    if (blocked || optOut)
      throw new HostNotAllowedError();
  };

  const send = async (target: RoutingTarget, method: string, headers: Record<string, string | readonly string[]>, body: Buffer | undefined, signal?: AbortSignal): Promise<OutboundResponse> => {
    try {
      return await http.request({ url: target.url, method, headers, body, redirect: 'none', ...signal ? { signal } : {} });
    }
    catch (error) {
      // OH-5: a host that resolves to our addresses
      if (error instanceof OwnHostError)
        throw new HostNotAllowedError();
      if (error instanceof OutboundHttpError)
        throw new UpstreamUnavailableError();
      throw error;
    }
  };

  /** RT-3 to RT-5: the probe, the option, and the quote, cached by method and URL. */
  const quoteFor = async (target: RoutingTarget, method: string, headers: Record<string, string | readonly string[]>, body: Buffer | undefined): Promise<RoutingQuote> => {
    const key = `${redis.prefix}quote:${method} ${target.url}`;
    try {
      const cached = await redis.client.get(key);
      if (cached !== null)
        return parseQuote(cached);
    }
    catch (error) {
      logger.warn({ error }, 'The quote cache is unavailable');
    }

    const response = await send(target, method, headers, body);
    if (response.status !== 402) {
      response.dispose();
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
    const chosen = challenge && chooseOption(challenge, config);
    if (!challenge || !chosen)
      throw new UnsupportedPaymentError();

    const feeBps = await routing.endpointFee(target.host, target.path) ?? config.routingFeeBps;
    const { quote, fee } = routingQuote(chosen.price, feeBps);
    const result: RoutingQuote = {
      x402Version: challenge.x402Version, requirement: chosen.requirement, resource: challenge.resource, asset: chosen.asset.name, price: chosen.price, fee, quote,
    };
    try {
      await redis.client.set(key, serializeQuote(result), { expiration: { type: 'EX', value: quoteTtlSeconds } });
    }
    catch (error) {
      logger.warn({ error }, 'Failed to cache a quote');
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

  /** What the target's PAYMENT-RESPONSE says it settled, if anything (RT-9). */
  const settledReceipt = (response: OutboundResponse): string | undefined => {
    const header = response.headers['payment-response'] ?? response.headers['x-payment-response'];
    const value = Array.isArray(header) ? header[0] : header;
    if (typeof value !== 'string' || value === '')
      return undefined;
    try {
      const decoded = JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as { success?: unknown };

      return decoded.success === true ? value : undefined;
    }
    catch {
      return undefined;
    }
  };

  const serve = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const target = parseRoutingTarget(request.raw.url ?? '/');
    await checkHost(target);
    const headers = routedRequestHeaders(request.headers, request.id);
    const body = request.body as Buffer | undefined;
    const quoted = await quoteFor(target, request.method, headers, body);

    // RT-6: the buyer pays the quote, with a key, x402, or MPP; or gets the combined 402 at it
    const payment = await payments.beginRouted({
      headers: request.headers, ip: request.ip, requestId: request.id, host: target.host, path: target.path,
      resource: `${payUrl}/${target.host}${target.path}`, quote: quoted.quote,
    });
    if (payment.kind === 'challenge')
      return reply.status(payment.response.status).headers(payment.response.headers).send(payment.response.body);

    const call: PaidCall = payment.call;
    const { paymentId } = call.authorization;
    const abortBuyer = async (status: number | undefined): Promise<void> => {
      await payments.finish(call, await payments.decide(call, { status, latencyMs: 0 }));
    };

    // RT-7: pay the target only now, through the Signer, within the quote (SG-3)
    if (!signer) {
      await abortBuyer(undefined);
      throw new UpstreamUnavailableError();
    }
    let signed;
    try {
      signed = await signer.sign({
        requestId: request.id, quoteId: paymentId, x402Version: quoted.x402Version, requirement: quoted.requirement, resource: quoted.resource,
        url: target.url, quotedPrice: quoted.price,
      });
    }
    catch (error) {
      await abortBuyer(undefined);
      if (error instanceof SignerUnavailableError) {
        logger.warn({ error, paymentId, host: target.host }, 'The Signer didn\'t sign a routed payment');
        throw new UpstreamUnavailableError();
      }
      throw error;
    }
    // RT-11: the target leg, recorded before the payment goes out
    await routing.recordTargetPayment({
      paymentId, protocol: 'x402', network: signed.network, asset: signed.asset, amount: signed.amount, atomicAmount: signed.atomicAmount,
      payTo: signed.payTo, signatureId: signed.signatureId,
    });

    const paymentHeader = quoted.x402Version >= 2 ? 'payment-signature' : 'x-payment';
    const started = performance.now();
    let response: OutboundResponse;
    try {
      response = await send(target, request.method, { ...headers, [paymentHeader]: signed.header }, body);
    }
    catch (error) {
      // Unknown: the target may have the signed authorization. The buyer isn't charged; the leg stays unknown.
      await routing.updateTargetPayment(paymentId, { status: 'unknown' });
      await abortBuyer(undefined);
      throw error;
    }
    const latencyMs = Math.round(performance.now() - started);

    // RT-8: a retry that asks for more than the quote is refused; the buyer isn't charged
    if (response.status === 402) {
      const challenge = parseTargetChallenge(response.headers, (await response.bytes().catch(() => Buffer.alloc(0))).subarray(0, challengeBodyLimit));
      const again = challenge && chooseOption(challenge, config);
      await routing.updateTargetPayment(paymentId, { status: 'failed' });
      await abortBuyer(402);
      await redis.client.del(`${redis.prefix}quote:${request.method} ${target.url}`).catch(() => undefined);
      if (again && again.price > quoted.price)
        throw new QuoteExceededError();
      throw new UpstreamUnavailableError();
    }

    const receipt = settledReceipt(response);
    response.body.on('error', () => undefined);
    const decision = await payments.decide(call, { status: response.status, latencyMs });
    const answerHeaders = responseHeaders(target, response);
    const bodyless = request.method === 'HEAD' || response.status === 204 || response.status === 304;
    if (decision !== 'billable') {
      // RT-9: not charged. If the target kept our payment anyway, it's a routing loss.
      await payments.finish(call, decision);
      if (receipt) {
        await routing.updateTargetPayment(paymentId, { status: 'settled', receipt });
        await ledger.routingLoss({ paymentId });
        logger.warn({ paymentId, host: target.host, status: response.status }, 'A target kept a routed payment for a failed call: booked as a routing loss');
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

    await routing.updateTargetPayment(paymentId, { status: 'settled', ...receipt ? { receipt } : {} });
    registrar.register(target.host, target.path, quoted.quote);
    if (call.rail.settlesBeforeResponse) {
      // x402 and MPP buyers: settle before any byte goes out (PX-12)
      const buffered = bodyless ? undefined : await response.bytes();
      if (bodyless)
        response.dispose();
      const buyerReceipt = await payments.settleNow(call);

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
      await checkHost(target);
      const quoted = await quoteFor(target, 'GET', routedRequestHeaders({}, request.id), undefined);
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
