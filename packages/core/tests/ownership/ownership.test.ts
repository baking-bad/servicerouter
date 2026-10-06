import { fixtureTime } from '@servicerouter/testing';

import { describe, expect, it } from 'vitest';

import {
  generateConfirmationToken, generateVerificationToken, graceEndOf, nextHostState, ownershipGracePeriodMs, ownershipRecheckIntervalMs,
  parseOwnershipFile, serviceStateFor, type RandomSource,
} from '../../src/index.js';

const now = new Date(fixtureTime(-4, 1, 0, 0, 0, 0));
const later = (ms: number): Date => new Date(now.getTime() + ms);
const day = 24 * 60 * 60 * 1_000;

describe('the ownership file (OV-2, OV-8)', () => {
  it('reads version 1 with its verification tokens and routing flag, ignoring fields it doesn\'t know', () => {
    const result = parseOwnershipFile(JSON.stringify({
      version: 1,
      verification: ['sr-verify=aa', 'sr-confirm=bb'],
      services: [{ id: 'weather-pro', url: 'https://pay.servicerouter.ai/service/weather-pro' }],
      routing: false,
      later: { anything: true },
    }));

    expect(result).toEqual({ ok: true, file: { version: 1, verification: ['sr-verify=aa', 'sr-confirm=bb'], routing: false } });
    expect(parseOwnershipFile('{"version":1,"verification":[]}')).toEqual({ ok: true, file: { version: 1, verification: [], routing: undefined } });
  });

  it.each([
    ['not JSON', 'sr-verify=aa', 'the file isn\'t valid JSON'],
    ['an array', '[]', 'the file isn\'t a JSON object'],
    ['another version', '{"version":2,"verification":[]}', 'version must be 1'],
    ['no verification', '{"version":1}', 'verification must be a list of tokens'],
    ['a token that isn\'t a string', '{"version":1,"verification":[1]}', 'each verification token must be a string of at most 256 characters'],
    ['services that isn\'t a list', '{"version":1,"verification":[],"services":{}}', 'services must be a list'],
    ['routing that isn\'t a boolean', '{"version":1,"verification":[],"routing":"no"}', 'routing must be true or false'],
  ])('refuses %s with a fixed reason that quotes nothing', (_name, text, reason) => {
    expect(parseOwnershipFile(text)).toEqual({ ok: false, reason });
  });
});

describe('tokens (OV-1, OV-10)', () => {
  it('makes sr-verify= and sr-confirm= tokens of 16 random bytes in hex', () => {
    const random: RandomSource = { bytes: size => new Uint8Array(size).fill(0xab) };

    expect(generateVerificationToken(random)).toBe(`sr-verify=${'ab'.repeat(16)}`);
    expect(generateConfirmationToken(random)).toBe(`sr-confirm=${'ab'.repeat(16)}`);
    expect(generateVerificationToken()).toMatch(/^sr-verify=[0-9a-f]{32}$/);
    expect(generateVerificationToken()).not.toBe(generateVerificationToken());
  });
});

describe('host states (OV-4)', () => {
  it('verifies a host whose file lists the token, from any state, and checks it again in a day', () => {
    for (const state of ['unverified', 'verified', 'missing', 'suspended'] as const)
      expect(nextHostState({ state, missingSince: state === 'unverified' ? undefined : now }, true, now)).toEqual({ state: 'verified', missingSince: undefined, nextCheckAt: later(day) });
    expect(nextHostState(undefined, true, now).state).toBe('verified');
  });

  it('keeps an unverified host unverified when the token isn\'t found', () => {
    expect(nextHostState(undefined, false, now)).toEqual({ state: 'unverified', missingSince: undefined, nextCheckAt: later(day) });
  });

  it('moves a verified host to missing and starts its 7-day grace period', () => {
    expect(nextHostState({ state: 'verified', missingSince: undefined }, false, now)).toEqual({ state: 'missing', missingSince: now, nextCheckAt: later(day) });
    expect(ownershipGracePeriodMs).toBe(7 * day);
    expect(graceEndOf(now)).toEqual(later(7 * day));
  });

  it('keeps a missing host missing during the grace period, and checks it again at its end if that comes first', () => {
    const missing = { state: 'missing', missingSince: now } as const;

    expect(nextHostState(missing, false, later(3 * day))).toEqual({ state: 'missing', missingSince: now, nextCheckAt: later(4 * day) });
    expect(nextHostState(missing, false, later(6.5 * day))).toEqual({ state: 'missing', missingSince: now, nextCheckAt: later(7 * day) });
  });

  it('suspends a missing host once its grace period is over, and keeps it suspended until the token returns', () => {
    const missing = { state: 'missing', missingSince: now } as const;

    expect(nextHostState(missing, false, later(7 * day))).toEqual({ state: 'suspended', missingSince: now, nextCheckAt: later(8 * day) });
    expect(nextHostState({ state: 'suspended', missingSince: now }, false, later(9 * day))).toMatchObject({ state: 'suspended' });
    expect(ownershipRecheckIntervalMs).toBe(day);
  });
});

describe('service state from its hosts (SR-8, OV-5)', () => {
  it('is suspended while any host is, live while every host is verified or in grace, and pending otherwise', () => {
    expect(serviceStateFor(['verified', 'verified'])).toBe('live');
    expect(serviceStateFor(['verified', 'missing'])).toBe('live');
    expect(serviceStateFor(['verified', 'unverified'])).toBe('pending');
    expect(serviceStateFor(['verified', undefined])).toBe('pending');
    expect(serviceStateFor(['suspended', 'unverified'])).toBe('suspended');
  });
});
