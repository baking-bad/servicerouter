import { generateKeyPairSync, verify } from 'node:crypto';

import { generateKeyPairSigner } from '@solana/kit';
import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, decodePaymentSignatureHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger, Secret } from '@servicerouter/common';
import { loadPlatformConfig, type NewPayment, type PlatformConfig, type SettleInput } from '@servicerouter/core';
import {
  cardanoAnswers, encodeBase58, facilitatorAnswers, startFakeFacilitator, startFakeSolanaRpc, type FakeFacilitator, type FakeSolanaRpc,
} from '@servicerouter/testing';

import {
  createFacilitators, createX402Rail, FacilitatorUnavailableError, initializeX402, PaymentInvalidError, SettlementFailedError,
  type PaymentRail, type PaymentRecorder, type Quote, type SettlementLedger, type X402Setup,
} from '../../src/index.js';

const base = 'eip155:84532';
const solana = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const basePayTo = '0x2222222222222222222222222222222222222222';
const solanaPayTo = encodeBase58(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
const clock = { now: () => new Date() };
const logger = createLogger({ level: 'silent' });

let facilitator: FakeFacilitator;
let rpc: FakeSolanaRpc;
let config: PlatformConfig;
let setup: X402Setup;

const configWith = (url: string, overrides: Record<string, unknown> = {}) => loadPlatformConfig({
  env: {
    CONFIG_PATH: 'config/example.yaml',
    CONFIG: Buffer.from(JSON.stringify({
      facilitators: [
        { name: 'cdp', url, networks: [base, solana] },
        { name: 'cardano', url: 'http://cardano-facilitator:4022', networks: ['cardano:preprod'], enabled: false },
      ],
      ...overrides,
    })).toString('base64'),
  },
});

beforeAll(async () => {
  [facilitator, rpc] = await Promise.all([
    startFakeFacilitator({ networks: [base, solana], feePayer: encodeBase58(Uint8Array.from({ length: 32 }, () => 7)) }),
    startFakeSolanaRpc(),
  ]);
  const document = await configWith(facilitator.url);
  config = {
    ...document,
    assets: document.assets.map(asset => asset.name === 'base-usdc' ? { ...asset, payTo: basePayTo } : asset.name === 'solana-usdc' ? { ...asset, payTo: solanaPayTo } : asset),
  };
  setup = await initializeX402({ config, facilitators: createFacilitators({ config, cdpApiKey: () => { throw new Error('No CDP auth here'); }, clock }), timeoutMs: 5_000 });
});

afterAll(async () => {
  await Promise.all([facilitator?.close(), rpc?.close()]);
});

beforeEach(() => {
  facilitator.reset();
});

// In-memory ports: what the rail records and books
const createPorts = () => {
  const created: (NewPayment & { status: string })[] = [];
  const changes: Record<string, unknown>[] = [];
  const settled: SettleInput[] = [];
  const recorder = {
    create: async (payment: NewPayment & { status: string }) => {
      created.push(payment);

      return payment;
    },
    changeStatus: async (change: Record<string, unknown>) => {
      changes.push(change);

      return change;
    },
  } as unknown as PaymentRecorder;
  const ledger: SettlementLedger = {
    settle: async input => {
      settled.push(input);

      return { payment: {} as never, fee: 0n, sellerAmount: 0n };
    },
  };

  return { created, changes, settled, rail: createX402Rail({ setup, recorder, ledger, logger }) };
};

let counter = 0;
const quoteOf = (price = 1_000n): Quote => {
  counter += 1;

  return {
    paymentId: `pay_x402_${counter}`,
    requestId: `req-${counter}`,
    resource: 'https://pay.staging.servicerouter.ai/service/weather/weather/oslo',
    priceMicroUsd: price,
    description: 'Current weather',
    subject: { kind: 'service', serviceId: 'weather', routeKey: 'getWeather', sellerAccountId: 'acc_seller' },
    feeBps: 250,
  };
};

const requiredOf = async (rail: PaymentRail, quote: Quote): Promise<PaymentRequired> =>
  decodePaymentRequiredHeader((await rail.challenge(quote))!.headers!['payment-required']!);

const buyer = privateKeyToAccount(generatePrivateKey());

/** A payment the official x402 client signs for one of the 402's options, on `network`. */
const pay = async (required: PaymentRequired, network: string): Promise<string> => {
  const client = new x402Client()
    .register(base, new ExactEvmScheme(buyer))
    .register(solana, new ExactSvmScheme(await generateKeyPairSigner(), { rpcUrl: rpc.url }));

  return encodePaymentSignatureHeader(await client.createPaymentPayload({ ...required, accepts: required.accepts.filter(option => option.network === network) }));
};

const paidCredential = (rail: PaymentRail, header: string) => rail.detect({ 'payment-signature': header })!;

describe('the x402 challenge (PR-2, PR-3, PR-5)', () => {
  it('offers one exact option per asset on Base and Solana with the price in atomic units, and none on Cardano', async () => {
    const { rail } = createPorts();

    const required = await requiredOf(rail, quoteOf(1_234n));

    expect(required).toMatchObject({ x402Version: 2, resource: { url: 'https://pay.staging.servicerouter.ai/service/weather/weather/oslo' } });
    expect(required.accepts).toEqual([
      expect.objectContaining({ scheme: 'exact', network: base, asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', amount: '1234', payTo: basePayTo, extra: expect.objectContaining({ name: 'USDC', version: '2' }) }),
      expect.objectContaining({ scheme: 'exact', network: solana, asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', amount: '1234', payTo: solanaPayTo, extra: expect.objectContaining({ feePayer: expect.any(String) }) }),
    ]);
  });

  it('skips an asset whose minimum price is above the call\'s (PR-3)', async () => {
    const pricier = await configWith(facilitator.url, { assets: undefined });
    const minimum = { ...pricier, assets: pricier.assets.map(asset => asset.name === 'solana-usdc' ? { ...asset, minPrice: 50_000n } : asset) };
    const narrowed = await initializeX402({ config: minimum, facilitators: createFacilitators({ config: minimum, cdpApiKey: () => { throw new Error('none'); }, clock }), timeoutMs: 5_000 });
    const rail = createX402Rail({ setup: narrowed, recorder: {} as PaymentRecorder, ledger: {} as SettlementLedger, logger });

    expect((await requiredOf(rail, quoteOf(1_000n))).accepts.map(option => option.network)).toEqual([base]);
    expect((await requiredOf(rail, quoteOf(50_000n))).accepts.map(option => option.network)).toEqual([base, solana]);
  });
});

describe('x402 payments through the facilitator (PR-5, PR-10, PR-12)', () => {
  it.each([
    ['Base', base, 'base-usdc'],
    ['Solana', solana, 'solana-usdc'],
  ])('verifies a payment signed on %s by the official client, records it, then settles and books it', async (_case, network, asset) => {
    const { rail, created, settled } = createPorts();
    const quote = quoteOf();
    const header = await pay(await requiredOf(rail, quote), network);

    const authorization = await rail.authorize(paidCredential(rail, header), quote);
    const receipt = await rail.finalize(authorization);

    expect(created).toEqual([expect.objectContaining({ id: quote.paymentId, rail: 'x402', status: 'verified', network, atomicAmount: 1_000n, amount: 1_000n, sellerAccountId: 'acc_seller' })]);
    expect(authorization.buyer).toMatch(new RegExp(`^address:${network}:`));
    expect(settled).toEqual([expect.objectContaining({ paymentId: quote.paymentId, feeBps: 250, asset, needsReview: false, transactionHash: expect.any(String) })]);
    expect(decodePaymentResponseHeader(receipt.headers['payment-response']!)).toMatchObject({ success: true, network });
    expect(facilitator.requests.map(request => request.path)).toEqual(expect.arrayContaining(['/verify', '/settle']));
  });

  it('refuses a payment the facilitator rejects with payment_invalid, recording nothing', async () => {
    const { rail, created } = createPorts();
    const quote = quoteOf();
    facilitator.handle('/verify', facilitatorAnswers.invalid('insufficient_funds'));

    const error = await rail.authorize(paidCredential(rail, await pay(await requiredOf(rail, quote), base)), quote).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PaymentInvalidError);
    expect((error as Error).message).toContain('insufficient_funds');
    expect(created).toEqual([]);
  });

  it.each([
    ['a payment for another price', async (rail: PaymentRail) => pay(await requiredOf(rail, quoteOf(999n)), base)],
    ['a header that isn\'t base64 JSON', async () => 'not a payment'],
    ['a payment that adds another transfer method to the quote, Permit2 on Base (PR-8)', async (rail: PaymentRail) => {
      const payload = decodePaymentSignatureHeader(await pay(await requiredOf(rail, quoteOf()), base));

      return encodePaymentSignatureHeader({ ...payload, accepted: { ...payload.accepted, extra: { ...payload.accepted.extra, assetTransferMethod: 'permit2' } } });
    }],
  ])('refuses %s with payment_invalid before asking the facilitator', async (_case, header) => {
    const { rail } = createPorts();
    const before = facilitator.requests.length;

    await expect(rail.authorize(paidCredential(rail, await header(rail)), quoteOf())).rejects.toBeInstanceOf(PaymentInvalidError);
    expect(facilitator.requests.length).toBe(before);
  });

  it('refuses x402 v1 (X-PAYMENT) with payment_invalid', async () => {
    const { rail } = createPorts();

    await expect(rail.authorize(rail.detect({ 'x-payment': 'eyJ4NDAyVmVyc2lvbiI6MX0=' })!, quoteOf())).rejects.toThrow(/PAYMENT-SIGNATURE/);
  });

  it('refuses a payment the facilitator answers with a plain 400, as live CDP does for a malformed one', async () => {
    const { rail } = createPorts();
    const quote = quoteOf();
    facilitator.handle('/verify', () => ({ status: 400, body: { errorType: 'invalid_request', errorMessage: '\'paymentPayload\' is invalid' } }));

    await expect(rail.authorize(paidCredential(rail, await pay(await requiredOf(rail, quote), base)), quote)).rejects.toThrow('The facilitator rejected the payment: invalid_payload');
  });

  it.each([401, 403, 429])('treats a %i at verify as the facilitator being unavailable, not the payment being invalid', async status => {
    const { rail } = createPorts();
    const quote = quoteOf();
    facilitator.handle('/verify', () => ({ status, body: { errorType: 'unauthorized' } }));

    await expect(rail.authorize(paidCredential(rail, await pay(await requiredOf(rail, quote), base)), quote)).rejects.toBeInstanceOf(FacilitatorUnavailableError);
  });

  it('answers a facilitator that is down at verify with facilitator_unavailable', async () => {
    const { rail } = createPorts();
    const quote = quoteOf();
    facilitator.handle('/verify', facilitatorAnswers.unavailable);

    await expect(rail.authorize(paidCredential(rail, await pay(await requiredOf(rail, quote), base)), quote)).rejects.toBeInstanceOf(FacilitatorUnavailableError);
  });

  it.each([
    ['verify, with 200 and isValid false', '/verify' as const, cardanoAnswers.verifyBackendDown()],
    ['settle, with 503', '/settle' as const, cardanoAnswers.backendDown(503)],
    ['settle, with 200', '/settle' as const, cardanoAnswers.backendDown(200)],
  ])('treats a chain backend that is down at %s as the facilitator being unavailable: the outcome is unknown (CF-6, step 6)', async (_case, path, answer) => {
    const [client] = createFacilitators({ config, cdpApiKey: () => { throw new Error('none'); }, clock });
    const quote = quoteOf();
    const { rail } = createPorts();
    const payload = decodePaymentSignatureHeader(await pay(await requiredOf(rail, quote), base));
    facilitator.handle(path, answer);

    const call = path === '/verify' ? client!.verify(payload, payload.accepted) : client!.settle(payload, payload.accepted);

    await expect(call).rejects.toBeInstanceOf(FacilitatorUnavailableError);
  });

  const authorized = async () => {
    const ports = createPorts();
    const quote = quoteOf();
    const authorization = await ports.rail.authorize(paidCredential(ports.rail, await pay(await requiredOf(ports.rail, quote), base)), quote);

    return { ...ports, quote, authorization };
  };

  it('sends the response on a pending settlement with a hash, and records it as settling with what to repeat (PR-12)', async () => {
    const { rail, changes, settled, authorization, quote } = await authorized();
    facilitator.handle('/settle', facilitatorAnswers.pending('0xbroadcast'));
    const before = facilitator.requests.length;

    const receipt = await rail.finalize(authorization);

    expect(decodePaymentResponseHeader(receipt.headers['payment-response']!)).toMatchObject({ success: false, errorReason: 'settlement_pending', transaction: '0xbroadcast' });
    expect(changes).toEqual([expect.objectContaining({
      paymentId: quote.paymentId, to: 'settling', transactionHash: '0xbroadcast', receipt: receipt.headers['payment-response'],
      settlementRequest: { paymentPayload: expect.objectContaining({ x402Version: 2 }), paymentRequirements: expect.objectContaining({ network: base }) },
    })]);
    expect(settled).toEqual([]);
    // The SDK repeats a pending settle once before answering
    expect(facilitator.requests.slice(before).map(request => request.path)).toEqual(['/settle', '/settle']);
  });

  it.each([
    ['a timeout', facilitatorAnswers.timeout(1_500), 'settling'],
    ['a 503', facilitatorAnswers.unavailable, 'settling'],
    ['a failed settlement', facilitatorAnswers.failed(), 'failed'],
    ['a plain 400, refused before anything was submitted', () => ({ status: 400, body: { errorMessage: 'invalid' } }), 'failed'],
    ['a 401', () => ({ status: 401, body: { errorType: 'unauthorized' } }), 'settling'],
  ])('refuses to send the response on %s with settlement_failed, recording it as %s (PR-12)', async (_case, answer, status) => {
    const { rail, changes, settled, authorization } = await authorized();
    facilitator.handle('/settle', answer);

    await expect(rail.finalize(authorization)).rejects.toBeInstanceOf(SettlementFailedError);

    expect(changes).toEqual([expect.objectContaining({ to: status, settlementRequest: status === 'settling' ? expect.any(Object) : null })]);
    expect(changes[0]).not.toHaveProperty('receipt');
    expect(settled).toEqual([]);
  });

  it('cancels on abort: nothing settles (PR-5)', async () => {
    const { rail, changes, authorization } = await authorized();
    const before = facilitator.requests.filter(request => request.path === '/settle').length;

    await rail.abort(authorization);

    expect(changes).toEqual([{ paymentId: authorization.paymentId, to: 'cancelled' }]);
    expect(facilitator.requests.filter(request => request.path === '/settle')).toHaveLength(before);
  });
});

describe('facilitators at startup (PR-6)', () => {
  it('fails fast when a facilitator\'s /supported fails', async () => {
    const down = await startFakeFacilitator({ networks: [base] });
    down.handle('/supported', facilitatorAnswers.unavailable);
    try {
      const broken = await configWith(down.url);

      await expect(initializeX402({ config: broken, facilitators: createFacilitators({ config: broken, cdpApiKey: () => { throw new Error('none'); }, clock }), timeoutMs: 2_000 }))
        .rejects.toThrow('The cdp facilitator\'s /supported failed');
    }
    finally {
      await down.close();
    }
  });

  it('fails fast when a facilitator\'s /supported doesn\'t list exact on a network it is configured for (step 6)', async () => {
    const baseOnly = await startFakeFacilitator({ networks: [base] });
    try {
      const both = await configWith(baseOnly.url);

      await expect(initializeX402({ config: both, facilitators: createFacilitators({ config: both, cdpApiKey: () => { throw new Error('none'); }, clock }), timeoutMs: 2_000 }))
        .rejects.toThrow(`The cdp facilitator's /supported doesn't list exact on ${solana}`);
    }
    finally {
      await baseOnly.close();
    }
  });

  it.each([
    ['Ed25519', 'EdDSA'],
    ['P-256', 'ES256'],
  ])('signs every request with a CDP JWT naming its method and path, with an %s key', async (kind, alg) => {
    const pair = kind === 'Ed25519' ? generateKeyPairSync('ed25519') : generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const secret = kind === 'Ed25519'
      ? Buffer.concat([
        Buffer.from(pair.privateKey.export({ format: 'jwk' }).d!, 'base64url'),
        Buffer.from(pair.publicKey.export({ format: 'jwk' }).x!, 'base64url'),
      ]).toString('base64')
      : pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString().replaceAll('\n', '\\n');
    const signed = await startFakeFacilitator({ networks: [base] });
    try {
      const withAuth = await configWith(signed.url, {
        facilitators: [
          { name: 'cdp', url: signed.url, networks: [base, solana], auth: { type: 'cdp', apiKeyId: 'CDP_API_KEY_ID', apiKeySecret: 'CDP_API_KEY_SECRET' } },
          { name: 'cardano', url: 'http://cardano-facilitator:4022', networks: ['cardano:preprod'], enabled: false },
        ],
      });
      const [client] = createFacilitators({ config: withAuth, cdpApiKey: () => ({ id: Secret.from('organizations/test/apiKeys/key-1'), secret: Secret.from(secret) }), clock });

      await client!.getSupported();

      const token = String(signed.requests[0]!.headers.authorization).replace(/^Bearer /, '');
      const [header, claims, signature] = token.split('.') as [string, string, string];
      const { publicKey } = pair;
      const valid = alg === 'EdDSA'
        ? verify(null, Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url'))
        : verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
      expect(valid).toBe(true);
      expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg, kid: 'organizations/test/apiKeys/key-1', typ: 'JWT', nonce: expect.stringMatching(/^[0-9a-f]{32}$/) });
      const payload = JSON.parse(Buffer.from(claims, 'base64url').toString()) as Record<string, unknown>;
      expect(payload).toEqual({
        sub: 'organizations/test/apiKeys/key-1', iss: 'cdp', uris: [`GET ${new URL(signed.url).host}/supported`],
        iat: expect.any(Number), nbf: expect.any(Number), exp: (payload['iat'] as number) + 120,
      });
    }
    finally {
      await signed.close();
    }
  });
});
