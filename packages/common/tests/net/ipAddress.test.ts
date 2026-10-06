import { describe, expect, it } from 'vitest';

import { isInRange, isSameAddress, parseIpAddress, parseIpRange, unmapIpv4 } from '../../src/index.js';

const hex = (text: string): string => Buffer.from(parseIpAddress(text)!.bytes).toString('hex');

describe('parseIpAddress', () => {
  it('parses IPv4', () => {
    expect(parseIpAddress('192.168.0.1')).toEqual({ version: 4, bytes: Uint8Array.from([192, 168, 0, 1]) });
  });

  it.each([
    ['::', '00000000000000000000000000000000'],
    ['::1', '00000000000000000000000000000001'],
    ['1::', '00010000000000000000000000000000'],
    ['2001:db8::8a2e:370:7334', '20010db80000000000008a2e03707334'],
    ['2001:DB8:0:0:0:0:0:1', '20010db8000000000000000000000001'],
    ['::ffff:127.0.0.1', '00000000000000000000ffff7f000001'],
    ['::ffff:7f00:1', '00000000000000000000ffff7f000001'],
    ['0:0:0:0:0:ffff:127.0.0.1', '00000000000000000000ffff7f000001'],
    ['::127.0.0.1', '0000000000000000000000007f000001'],
    ['64:ff9b::8.8.8.8', '0064ff9b000000000000000008080808'],
    ['[fe80::1]', 'fe800000000000000000000000000001'],
    ['fe80::1%en0', 'fe800000000000000000000000000001'],
  ])('parses IPv6 %s', (text, expected) => {
    expect(hex(text)).toBe(expected);
  });

  it.each(['', 'localhost', '256.0.0.1', '1.2.3', '01.2.3.4', '1:2:3:4:5:6:7:8:9', ':::', '::g', '2130706433'])('rejects %s', text => {
    expect(parseIpAddress(text)).toBeUndefined();
  });
});

describe('ranges', () => {
  it('matches CIDR prefixes on any bit boundary', () => {
    const range = parseIpRange('100.64.0.0/10');

    expect(isInRange(parseIpAddress('100.64.0.0')!, range)).toBe(true);
    expect(isInRange(parseIpAddress('100.127.255.255')!, range)).toBe(true);
    expect(isInRange(parseIpAddress('100.128.0.0')!, range)).toBe(false);
    expect(isInRange(parseIpAddress('::ffff:100.64.0.1')!, range)).toBe(false);
    expect(isInRange(parseIpAddress('10.0.0.1')!, parseIpRange('0.0.0.0/0'))).toBe(true);
    expect(isInRange(parseIpAddress('10.0.0.1')!, parseIpRange('10.0.0.1'))).toBe(true);
  });

  it.each(['10.0.0.0/33', '::/129', 'nope/8', '10.0.0.0/x', '10.0.0.0/'])('rejects the range %s', text => {
    expect(() => parseIpRange(text)).toThrow('Invalid IP range');
  });

  it('unmaps IPv4-mapped addresses and compares across forms', () => {
    expect(unmapIpv4(parseIpAddress('::ffff:10.1.2.3')!)).toEqual({ version: 4, bytes: Uint8Array.from([10, 1, 2, 3]) });
    expect(unmapIpv4(parseIpAddress('::10.1.2.3')!).version).toBe(6);
    expect(isSameAddress(parseIpAddress('203.0.113.7')!, parseIpAddress('::ffff:cb00:7107')!)).toBe(true);
    expect(isSameAddress(parseIpAddress('2001:db8::1')!, parseIpAddress('2001:0db8:0:0::1')!)).toBe(true);
    expect(isSameAddress(parseIpAddress('203.0.113.7')!, parseIpAddress('203.0.113.8')!)).toBe(false);
  });
});
