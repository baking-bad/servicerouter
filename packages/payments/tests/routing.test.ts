import { fixtureTime } from '@servicerouter/testing';

import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { Challenge, Receipt } from 'mppx';
import { describe, expect, it } from 'vitest';

import type { MicroUsd } from '@servicerouter/common';
import { loadPlatformConfig } from '@servicerouter/core';

import {
  chooseOption, InvalidTargetError, mppRefusals, parseRoutingTarget, parseTargetChallenge, routingQuote, solanaRefusals, targetReceipt,
} from '../src/index.js';

const config = await loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } });
const usdc = config.assets.find(asset => asset.name === 'base-usdc')!.address;
const pathUsd = config.assets.find(asset => asset.name === 'tempo-pathusd')!.address;
const base = 'eip155:84532';
const now = new Date(fixtureTime(0, 7, 12, 0, 0, 0));

/** A target's Tempo charge, as `mppx`'s server writes it in `WWW-Authenticate: Payment`. */
const mppChallenge = (amount: string, details: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}): string => Challenge.serialize(Challenge.from({
  id: `challenge-${amount}`, realm: 'api.target.dev', method: 'tempo', intent: 'charge', expires: fixtureTime(0, 7, 12, 5, 0, 0),
  request: { amount, currency: pathUsd, recipient: '0x5555555555555555555555555555555555555555', methodDetails: { chainId: 42_431, supportedModes: ['pull'], ...details } },
  ...overrides,
} as never));

describe('the routing link (RT-1)', () => {
  it('takes the host, path, and query, and targets HTTPS', () => {
    expect(parseRoutingTarget('/API.Example.com/v1/pools?limit=10')).toEqual({
      host: 'api.example.com', hostname: 'api.example.com', path: '/v1/pools', search: '?limit=10', url: 'https://api.example.com/v1/pools?limit=10',
    });
    expect(parseRoutingTarget('/api.example.com:8443')).toMatchObject({ host: 'api.example.com:8443', hostname: 'api.example.com', path: '/' });
  });

  it.each(['/10.0.0.1/v1', '/[::1]/v1', '/localhost/v1', '/https:/api.example.com', '/api.example.com:http/v1'])('refuses %s with invalid_target', path => {
    expect(() => parseRoutingTarget(path)).toThrow(InvalidTargetError);
  });
});

describe('choosing the target\'s option (RT-3, RT-4) and the quote (RT-5)', () => {
  const plain = { scheme: 'exact', network: base, amount: '2000', asset: usdc, payTo: '0x1', maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' } };
  const header = (accepts: unknown[]) => ({ 'payment-required': encodePaymentRequiredHeader({ x402Version: 2, resource: { url: 'https://a.b/c' }, accepts } as never) });

  it('reads the v2 header and the v1 body', () => {
    expect(parseTargetChallenge(header([plain]), new Uint8Array())).toMatchObject({ x402Version: 2, accepts: [plain] });
    expect(parseTargetChallenge({}, Buffer.from(JSON.stringify({ x402Version: 1, accepts: [plain] })))).toMatchObject({ x402Version: 1 });
    expect(parseTargetChallenge({}, Buffer.from('<html>'))).toBeUndefined();
  });

  it('picks the cheapest exact option on a network we pay, skipping Gateway nanopayments and unknown assets', () => {
    const challenge = parseTargetChallenge(header([
      { ...plain, amount: '10000000' },
      { ...plain, amount: '100', extra: { name: 'GatewayWalletBatched', version: '1' } },
      { ...plain, amount: '50', asset: '0x0000000000000000000000000000000000000001' },
      { ...plain, amount: '10', network: 'eip155:1' },
      { ...plain, amount: '5', scheme: 'upto' },
      plain,
    ]), new Uint8Array())!;

    expect(chooseOption(challenge, config, now)).toMatchObject({ protocol: 'x402', asset: { name: 'base-usdc' }, atomicAmount: 2000n, price: 2000n });
    expect(chooseOption(parseTargetChallenge(header([{ ...plain, scheme: 'upto' }]), new Uint8Array())!, config, now)).toBeUndefined();
  });

  it('reads an MPP challenge of WWW-Authenticate: Payment, alone or beside x402, keeping its expiry and digest (RT-3, T27)', () => {
    const alone = parseTargetChallenge({ 'www-authenticate': mppChallenge('1000', {}, { digest: 'sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:' }) }, new Uint8Array())!;
    const both = parseTargetChallenge({ ...header([plain]), 'www-authenticate': [mppChallenge('1000'), mppChallenge('2000')] }, new Uint8Array())!;

    expect(alone).toMatchObject({ x402Version: 0, accepts: [], mpp: [{ method: 'tempo', intent: 'charge', expires: fixtureTime(0, 7, 12, 5, 0, 0) }] });
    expect(alone.mpp[0]!.digest).toBeDefined();
    expect(both).toMatchObject({ x402Version: 2, accepts: [plain] });
    expect(both.mpp.map(item => item.request['amount'])).toEqual(['1000', '2000']);
    expect(parseTargetChallenge({ 'www-authenticate': 'Bearer realm="api"' }, new Uint8Array())).toBeUndefined();
  });

  it('chooses an MPP Tempo charge at its price, rounded up, and binds no quote to a body unless its challenge does (RT-4, T27)', () => {
    const chosen = chooseOption(parseTargetChallenge({ 'www-authenticate': mppChallenge('1500') }, new Uint8Array())!, config, now);

    expect(chosen).toMatchObject({
      protocol: 'mpp', asset: { name: 'tempo-pathusd' }, atomicAmount: 1500n, price: 1500n, expires: fixtureTime(0, 7, 12, 5, 0, 0), bindsBody: false,
    });
    expect(chosen?.protocol === 'mpp' && Challenge.deserialize(chosen.challenge).id).toBe('challenge-1500');
  });

  it('chooses x402 on Base on a tie, and MPP on Tempo when it is cheaper (RT-4, T27)', () => {
    const tie = parseTargetChallenge({ ...header([plain]), 'www-authenticate': mppChallenge('2000') }, new Uint8Array())!;
    const cheaper = parseTargetChallenge({ ...header([plain]), 'www-authenticate': mppChallenge('1999') }, new Uint8Array())!;

    expect(chooseOption(tie, config, now)).toMatchObject({ protocol: 'x402', price: 2000n });
    expect(chooseOption(cheaper, config, now)).toMatchObject({ protocol: 'mpp', price: 1999n });
  });

  describe('x402 targets on Solana (RT-4, T29)', () => {
    const solanaUsdc = config.assets.find(asset => asset.name === 'solana-usdc')!;
    const ourWallet = 'HGvHArgEcqSUut2Cppn6fBQzLxtsaj8vBccTFyxFJzhC';
    const withWallet = { ...config, signer: { ...config.signer, wallets: { ...config.signer.wallets, solana: ourWallet } } };
    const onSolana = (amount: string, extra: Record<string, unknown> = { feePayer: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4' }) => ({
      scheme: 'exact', network: solanaUsdc.network.id, amount, asset: solanaUsdc.address, payTo: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', maxTimeoutSeconds: 60, extra,
    });

    it('pays USDC on Solana at its price when the option names its facilitator\'s fee payer', () => {
      expect(chooseOption(parseTargetChallenge(header([onSolana('1500')]), new Uint8Array())!, withWallet, now))
        .toMatchObject({ protocol: 'x402', asset: { name: 'solana-usdc' }, atomicAmount: 1500n, price: 1500n });
    });

    it('pays no Solana option without a fee payer, or whose fee payer is our own wallet, and says why', () => {
      const challenge = parseTargetChallenge(header([onSolana('1000', {}), onSolana('1001', { feePayer: ourWallet })]), new Uint8Array())!;

      expect(chooseOption(challenge, withWallet, now)).toBeUndefined();
      expect(solanaRefusals(challenge, withWallet)).toEqual(['no_fee_payer', 'fee_payer_is_us']);
      // Base options give no Solana reason
      expect(solanaRefusals(parseTargetChallenge(header([plain]), new Uint8Array())!, withWallet)).toEqual([]);
    });

    it('chooses Base, then Solana, then MPP on Tempo at the same price, and a cheaper Solana option over both', () => {
      const all = (solanaAmount: string) => parseTargetChallenge({ ...header([onSolana(solanaAmount), plain]), 'www-authenticate': mppChallenge('2000') }, new Uint8Array())!;
      const withoutBase = parseTargetChallenge({ ...header([onSolana('2000')]), 'www-authenticate': mppChallenge('2000') }, new Uint8Array())!;

      expect(chooseOption(all('2000'), withWallet, now)).toMatchObject({ protocol: 'x402', asset: { name: 'base-usdc' } });
      expect(chooseOption(withoutBase, withWallet, now)).toMatchObject({ protocol: 'x402', asset: { name: 'solana-usdc' } });
      expect(chooseOption(all('1999'), withWallet, now)).toMatchObject({ protocol: 'x402', asset: { name: 'solana-usdc' }, price: 1999n });
    });
  });

  it('pays no MPP challenge in push mode only, with splits, in another currency, on another chain, or expired, and says why (RT-4, T27)', () => {
    const challenge = parseTargetChallenge({
      'www-authenticate': [
        mppChallenge('1000', { supportedModes: ['push'] }),
        mppChallenge('1001', { splits: [{ amount: '100', recipient: '0x6666666666666666666666666666666666666666' }] }),
        mppChallenge('1002', {}, { request: { amount: '1002', currency: '0x20c0000000000000000000000000000000000001', recipient: '0x5555555555555555555555555555555555555555' } }),
        mppChallenge('1003', { chainId: 4_217 }),
        mppChallenge('1004', {}, { expires: fixtureTime(0, 7, 11, 59, 59, 0) }),
      ].join(', '),
    }, new Uint8Array())!;

    expect(challenge.mpp).toHaveLength(5);
    expect(chooseOption(challenge, config, now)).toBeUndefined();
    expect(mppRefusals(challenge, config, now)).toEqual(['push_only', 'splits', 'unsupported_currency', 'wrong_chain', 'expired']);
  });

  it('reads the target\'s receipt: an x402 PAYMENT-RESPONSE that succeeded, or an MPP Payment-Receipt, with its transaction (RT-9, RT-11)', () => {
    const settled = encodePaymentResponseHeader({ success: true, transaction: '0xabc', network: base } as never);
    const failed = encodePaymentResponseHeader({ success: false, transaction: '', network: base, errorReason: 'insufficient_funds' } as never);
    const receipt = Receipt.serialize(Receipt.from({ method: 'tempo', status: 'success', reference: '0xdef', timestamp: now.toISOString() }));

    expect(targetReceipt({ 'payment-response': settled })).toEqual({ receipt: settled, transaction: '0xabc' });
    expect(targetReceipt({ 'payment-response': failed })).toBeUndefined();
    expect(targetReceipt({ 'payment-receipt': receipt })).toEqual({ receipt, transaction: '0xdef' });
    expect(targetReceipt({ 'payment-receipt': 'not-a-receipt' })).toBeUndefined();
    expect(targetReceipt({})).toBeUndefined();
  });

  it('adds the routing fee, rounded down (AR6)', () => {
    expect(routingQuote(1_000n as MicroUsd, 250)).toEqual({ quote: 1_025n, fee: 25n });
    expect(routingQuote(1_001n as MicroUsd, 250)).toEqual({ quote: 1_026n, fee: 25n });
    expect(routingQuote(1_000n as MicroUsd, 0)).toEqual({ quote: 1_000n, fee: 0n });
  });
});
