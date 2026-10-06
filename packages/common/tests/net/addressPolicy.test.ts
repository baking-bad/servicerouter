import { describe, expect, it } from 'vitest';

import { createAddressPolicy, publicAddressPolicy } from '../../src/index.js';

describe('publicAddressPolicy (OH-1)', () => {
  it.each([
    ['0.0.0.0', 'an unspecified or "this network" address'],
    ['0.1.2.3', 'an unspecified or "this network" address'],
    ['10.1.2.3', 'a private address'],
    ['172.16.0.1', 'a private address'],
    ['172.31.255.255', 'a private address'],
    ['192.168.1.1', 'a private address'],
    ['100.64.0.1', 'shared address space'],
    ['100.127.255.255', 'shared address space'],
    ['127.0.0.1', 'a loopback address'],
    ['127.255.255.254', 'a loopback address'],
    ['169.254.1.1', 'a link-local address'],
    ['169.254.169.254', 'a cloud metadata address'],
    ['169.254.170.2', 'a cloud metadata address'],
    ['100.100.100.200', 'a cloud metadata address'],
    ['192.0.0.192', 'a cloud metadata address'],
    ['192.0.0.8', 'an IETF protocol address'],
    ['192.0.2.1', 'a documentation address'],
    ['198.18.0.1', 'a benchmarking address'],
    ['224.0.0.1', 'a multicast address'],
    ['239.255.255.250', 'a multicast address'],
    ['240.0.0.1', 'a reserved or broadcast address'],
    ['255.255.255.255', 'a reserved or broadcast address'],
    ['::', 'an unspecified address'],
    ['::1', 'a loopback address'],
    ['::127.0.0.1', 'an IPv4-compatible or NAT64 address'],
    ['64:ff9b::808:808', 'an IPv4-compatible or NAT64 address'],
    ['fc00::1', 'a private address'],
    ['fd12:3456::1', 'a private address'],
    ['fd00:ec2::254', 'a cloud metadata address'],
    ['fe80::1', 'a link-local address'],
    ['fe80::1%eth0', 'a link-local address'],
    ['ff02::1', 'a multicast address'],
    ['2001:db8::1', 'a documentation address'],
    ['2001::1', 'an IETF protocol or Teredo address'],
    ['2002:c0a8:101::1', 'a 6to4 address'],
    ['::ffff:127.0.0.1', 'a loopback address'],
    ['::ffff:7f00:1', 'a loopback address'],
    ['0:0:0:0:0:ffff:a00:1', 'a private address'],
    ['::ffff:169.254.169.254', 'a cloud metadata address'],
    ['4000::1', 'not a global unicast address'],
    ['localhost', 'not an IP address'],
  ])('refuses %s as %s', (address, reason) => {
    expect(publicAddressPolicy.refuse(address)).toBe(reason);
  });

  it.each([
    '8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '192.88.100.1', '203.0.114.1', '169.255.0.1',
    '2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001::1', '::ffff:8.8.8.8',
  ])('allows the public address %s', address => {
    expect(publicAddressPolicy.refuse(address)).toBeUndefined();
  });

  it('is frozen', () => {
    expect(Object.isFrozen(publicAddressPolicy)).toBe(true);
  });
});

describe('createAddressPolicy', () => {
  const policy = createAddressPolicy({ allow: ['127.0.0.0/8', '::1'] });

  it('allows the listed ranges, in IPv4-mapped form too', () => {
    expect(policy.refuse('127.0.0.1')).toBeUndefined();
    expect(policy.refuse('::ffff:127.0.0.1')).toBeUndefined();
    expect(policy.refuse('::1')).toBeUndefined();
    expect(policy.refuse('8.8.8.8')).toBeUndefined();
  });

  it('refuses everything else the public policy refuses', () => {
    expect(policy.refuse('10.0.0.1')).toBe('a private address');
    expect(policy.refuse('169.254.169.254')).toBe('a cloud metadata address');
    expect(policy.refuse('::2')).toBe('an IPv4-compatible or NAT64 address');
  });
});
