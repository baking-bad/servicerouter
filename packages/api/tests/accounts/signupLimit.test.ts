import { describe, expect, it } from 'vitest';

import { clientOf } from '../../src/accounts/signupLimit.js';

describe('clientOf (PA-5)', () => {
  it.each([
    ['an IPv4 address', '192.0.2.1', '192.0.2.1'],
    ['an IPv4-mapped IPv6 address', '::ffff:192.0.2.1', '192.0.2.1'],
    ['an IPv6 address, by its /64', '2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['a compressed IPv6 address', '2001:db8::1', '2001:db8:0:0::/64'],
    ['IPv6 loopback', '::1', '0:0:0:0::/64'],
  ])('keys %s as one client', (_case, ip, expected) => {
    expect(clientOf(ip)).toBe(expected);
  });
});
