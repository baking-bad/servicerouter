import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

import { parseIpAddress } from '@servicerouter/common';

// Just enough DER to build a self-signed X.509 v3 certificate, so tests generate their TLS keys in the
// run instead of committing them.

const encodeLength = (length: number): number[] => length < 0x80
  ? [length]
  : length < 0x100 ? [0x81, length] : [0x82, length >> 8, length & 0xff];

const tlv = (tag: number, ...content: readonly Buffer[]): Buffer => {
  const body = Buffer.concat(content);

  return Buffer.concat([Buffer.from([tag, ...encodeLength(body.length)]), body]);
};

const sequence = (...content: readonly Buffer[]): Buffer => tlv(0x30, ...content);

const objectId = (dotted: string): Buffer => {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const bytes = [40 * first + second];
  for (let value of rest) {
    const group = [value & 0x7f];
    while ((value >>= 7) > 0)
      group.unshift(0x80 | (value & 0x7f));
    bytes.push(...group);
  }

  return tlv(0x06, Buffer.from(bytes));
};

const utcTime = (date: Date): Buffer => tlv(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`));
const extension = (id: string, critical: boolean, value: Buffer): Buffer =>
  sequence(objectId(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value));

export interface TestCertificate {
  // PEM. Doubles as its own CA: pass it to clients as `ca`
  readonly cert: string;
  readonly key: string;
}

export interface TestCertificateOptions {
  // DNS names and IP addresses the certificate is valid for
  readonly hosts: readonly string[];
}

/** A self-signed ECDSA P-256 server certificate, valid for one day. */
export const createTestCertificate = ({ hosts }: TestCertificateOptions): TestCertificate => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const name = sequence(tlv(0x31, sequence(objectId('2.5.4.3'), tlv(0x0c, Buffer.from('Service Router test')))));
  const signatureAlgorithm = sequence(objectId('1.2.840.10045.4.3.2'));
  // DER integers are minimal and signed: no leading zero byte, high bit clear
  const serial = randomBytes(16);
  serial[0] = (serial[0]! & 0x3f) | 0x40;
  const now = Date.now();
  const subjectAltNames = hosts.map(host => {
    const address = parseIpAddress(host);

    return address ? tlv(0x87, Buffer.from(address.bytes)) : tlv(0x82, Buffer.from(host));
  });

  const certificate = sequence(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    signatureAlgorithm,
    name,
    sequence(utcTime(new Date(now)), utcTime(new Date(now + 24 * 60 * 60_000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, sequence(
      extension('2.5.29.19', true, sequence(tlv(0x01, Buffer.from([0xff])))),
      // digitalSignature and keyCertSign
      extension('2.5.29.15', true, tlv(0x03, Buffer.from([0x02, 0x84]))),
      extension('2.5.29.37', false, sequence(objectId('1.3.6.1.5.5.7.3.1'))),
      extension('2.5.29.17', false, sequence(...subjectAltNames)),
    )),
  );
  const der = sequence(certificate, signatureAlgorithm, tlv(0x03, Buffer.from([0]), sign('sha256', certificate, privateKey)));
  const base64 = der.toString('base64').match(/.{1,64}/g)!.join('\n');

  return {
    cert: `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
};

/**
 * Makes Node's `fetch` trust only this certificate, for code that fetches without a way to pass a CA,
 * such as viem's HTTP transport. Returns the function that puts the previous dispatcher back.
 */
export const trustTestCertificate = (certificate: TestCertificate): (() => Promise<void>) => {
  const previous = getGlobalDispatcher();
  const agent = new Agent({ connect: { ca: certificate.cert } });
  setGlobalDispatcher(agent);

  return async () => {
    setGlobalDispatcher(previous);
    await agent.close();
  };
};
