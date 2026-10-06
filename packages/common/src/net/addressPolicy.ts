import { isInRange, parseIpAddress, parseIpRange, unmapIpv4, type IpRange } from './ipAddress.js';

/** Decides which resolved IP addresses Outbound HTTP may connect to (OH-1). */
export interface AddressPolicy {
  /** Why the address may not be reached, or undefined when it may. */
  refuse(address: string): string | undefined;
}

interface NamedRange {
  readonly range: IpRange;
  readonly reason: string;
}

const named = (reason: string, ...ranges: readonly string[]): NamedRange[] =>
  ranges.map(range => ({ range: parseIpRange(range), reason }));

// IANA special-purpose registries. More specific entries come first, so the reason is precise.
const refusedIpv4 = [
  ...named('a cloud metadata address', '169.254.169.254', '169.254.170.2', '100.100.100.200', '192.0.0.192'),
  ...named('an unspecified or "this network" address', '0.0.0.0/8'),
  ...named('a private address', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'),
  ...named('shared address space', '100.64.0.0/10'),
  ...named('a loopback address', '127.0.0.0/8'),
  ...named('a link-local address', '169.254.0.0/16'),
  ...named('an IETF protocol address', '192.0.0.0/24'),
  ...named('a documentation address', '192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24'),
  ...named('a 6to4 relay address', '192.88.99.0/24'),
  ...named('a benchmarking address', '198.18.0.0/15'),
  ...named('a multicast address', '224.0.0.0/4'),
  ...named('a reserved or broadcast address', '240.0.0.0/4'),
];

// Only global unicast is reachable. Inside it, these ranges are special-purpose or tunnel to IPv4.
const globalUnicastIpv6 = parseIpRange('2000::/3');
const refusedIpv6 = [
  ...named('an IETF protocol or Teredo address', '2001::/23'),
  ...named('a documentation address', '2001:db8::/32', '3fff::/20'),
  ...named('a 6to4 address', '2002::/16'),
];
const outsideGlobalUnicastIpv6 = [
  ...named('a cloud metadata address', 'fd00:ec2::254'),
  ...named('an unspecified address', '::/128'),
  ...named('a loopback address', '::1/128'),
  ...named('an IPv4-compatible or NAT64 address', '::/96', '64:ff9b::/96', '64:ff9b:1::/48'),
  ...named('a private address', 'fc00::/7', 'fec0::/10'),
  ...named('a link-local address', 'fe80::/10'),
  ...named('a multicast address', 'ff00::/8'),
];

const refusePublic = (text: string): string | undefined => {
  const parsed = parseIpAddress(text);
  if (!parsed)
    return 'not an IP address';

  // An IPv4-mapped IPv6 address reaches the IPv4 address inside it
  const address = unmapIpv4(parsed);
  if (address.version === 4)
    return refusedIpv4.find(({ range }) => isInRange(address, range))?.reason;
  if (!isInRange(address, globalUnicastIpv6))
    return outsideGlobalUnicastIpv6.find(({ range }) => isInRange(address, range))?.reason ?? 'not a global unicast address';

  return refusedIpv6.find(({ range }) => isInRange(address, range))?.reason;
};

/** Public addresses only. The only policy production may use (OH-7). */
export const publicAddressPolicy: AddressPolicy = Object.freeze({ refuse: refusePublic });

export interface AddressPolicyOptions {
  // Ranges to allow on top of the public policy, such as 127.0.0.0/8 for a test server
  readonly allow: readonly string[];
}

/** The public policy plus exceptions. For tests: Outbound HTTP refuses it in production. */
export const createAddressPolicy = ({ allow }: AddressPolicyOptions): AddressPolicy => {
  const allowed = allow.map(parseIpRange);

  return Object.freeze({
    refuse: (text: string) => {
      const parsed = parseIpAddress(text);
      const address = parsed && unmapIpv4(parsed);

      return address && allowed.some(range => isInRange(address, range)) ? undefined : refusePublic(text);
    },
  });
};
