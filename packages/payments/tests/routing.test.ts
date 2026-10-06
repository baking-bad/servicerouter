import { encodePaymentRequiredHeader } from '@x402/core/http';
import { describe, expect, it } from 'vitest';

import type { MicroUsd } from '@servicerouter/common';
import { loadPlatformConfig } from '@servicerouter/core';

import { chooseOption, InvalidTargetError, parseRoutingTarget, parseTargetChallenge, routingQuote } from '../src/index.js';

const config = await loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } });
const usdc = config.assets.find(asset => asset.name === 'base-usdc')!.address;
const base = 'eip155:84532';

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

    expect(chooseOption(challenge, config)).toMatchObject({ protocol: 'x402', asset: { name: 'base-usdc' }, atomicAmount: 2000n, price: 2000n });
    expect(chooseOption(parseTargetChallenge(header([{ ...plain, scheme: 'upto' }]), new Uint8Array())!, config)).toBeUndefined();
  });

  it('adds the routing fee, rounded down (AR6)', () => {
    expect(routingQuote(1_000n as MicroUsd, 250)).toEqual({ quote: 1_025n, fee: 25n });
    expect(routingQuote(1_001n as MicroUsd, 250)).toEqual({ quote: 1_026n, fee: 25n });
    expect(routingQuote(1_000n as MicroUsd, 0)).toEqual({ quote: 1_000n, fee: 0n });
  });
});
