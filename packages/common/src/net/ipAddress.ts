import { isIPv4, isIPv6 } from 'node:net';

export interface IpAddress {
  readonly version: 4 | 6;
  readonly bytes: Uint8Array;
}

export interface IpRange {
  readonly version: 4 | 6;
  readonly bytes: Uint8Array;
  readonly prefixLength: number;
}

const parseIpv4Bytes = (text: string): number[] => text.split('.').map(Number);

const parseIpv6Bytes = (text: string): number[] => {
  let head = text;
  const tail: number[] = [];
  // An embedded IPv4 tail, such as ::ffff:127.0.0.1
  const lastColon = head.lastIndexOf(':');
  if (head.slice(lastColon + 1).includes('.')) {
    tail.push(...parseIpv4Bytes(head.slice(lastColon + 1)));
    head = head.slice(0, lastColon + 1);
    if (head.endsWith(':') && !head.endsWith('::'))
      head = head.slice(0, -1);
  }

  const toWords = (part: string): number[] => part === '' ? [] : part.split(':').map(word => Number.parseInt(word, 16));
  const [left = '', right] = head.split('::');
  const leftWords = toWords(left);
  const rightWords = right === undefined ? [] : toWords(right);
  const missing = 8 - tail.length / 2 - leftWords.length - rightWords.length;
  const words = [...leftWords, ...Array<number>(right === undefined ? 0 : missing).fill(0), ...rightWords];

  return [...words.flatMap(word => [word >> 8, word & 0xff]), ...tail];
};

/** Parses an IPv4 or IPv6 address. Accepts brackets and drops an IPv6 zone, such as `%eth0`. */
export const parseIpAddress = (text: string): IpAddress | undefined => {
  const address = text.replace(/^\[(.*)\]$/, '$1').replace(/%.*$/, '');
  if (isIPv4(address))
    return { version: 4, bytes: Uint8Array.from(parseIpv4Bytes(address)) };
  if (isIPv6(address))
    return { version: 6, bytes: Uint8Array.from(parseIpv6Bytes(address.toLowerCase())) };

  return undefined;
};

export const isIpAddress = (text: string): boolean => parseIpAddress(text) !== undefined;

/** Parses a CIDR range, such as `10.0.0.0/8`, or a single address. */
export const parseIpRange = (text: string): IpRange => {
  const [addressText = '', prefixText] = text.split('/');
  const address = parseIpAddress(addressText);
  const bits = address ? address.bytes.length * 8 : 0;
  const prefixLength = prefixText === undefined ? bits : Number(prefixText);
  if (!address || !/^\d+$/.test(prefixText ?? String(bits)) || prefixLength > bits)
    throw new Error(`Invalid IP range ${text}`);

  return { version: address.version, bytes: address.bytes, prefixLength };
};

export const isInRange = (address: IpAddress, range: IpRange): boolean => {
  if (address.version !== range.version)
    return false;

  const fullBytes = Math.floor(range.prefixLength / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (address.bytes[index] !== range.bytes[index])
      return false;
  }

  const remainingBits = range.prefixLength % 8;
  if (remainingBits === 0)
    return true;

  const mask = (0xff << (8 - remainingBits)) & 0xff;

  return ((address.bytes[fullBytes] ?? 0) & mask) === ((range.bytes[fullBytes] ?? 0) & mask);
};

const ipv4MappedRange = parseIpRange('::ffff:0:0/96');

/** The IPv4 address inside an IPv4-mapped IPv6 address, such as ::ffff:10.0.0.1. */
export const unmapIpv4 = (address: IpAddress): IpAddress =>
  isInRange(address, ipv4MappedRange) ? { version: 4, bytes: address.bytes.slice(12) } : address;

export const isSameAddress = (left: IpAddress, right: IpAddress): boolean => {
  const [a, b] = [unmapIpv4(left), unmapIpv4(right)];

  return a.version === b.version && a.bytes.every((byte, index) => byte === b.bytes[index]);
};
