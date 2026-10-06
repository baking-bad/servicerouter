import { X509Certificate } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createTestCertificate } from '../src/index.js';

describe('createTestCertificate', () => {
  it('covers the given names and addresses', () => {
    const certificate = new X509Certificate(createTestCertificate({ hosts: ['api.example.com', '127.0.0.1', '::1'] }).cert);

    expect(certificate.checkHost('api.example.com')).toBe('api.example.com');
    expect(certificate.checkHost('other.example.com')).toBeUndefined();
    expect(certificate.checkIP('127.0.0.1')).toBe('127.0.0.1');
    expect(certificate.checkIP('::1')).toBe('::1');
    expect(certificate.ca).toBe(true);
  });

  it('always encodes valid DER, whatever the random serial', () => {
    for (let index = 0; index < 500; index += 1)
      expect(() => new X509Certificate(createTestCertificate({ hosts: ['api.example.com'] }).cert)).not.toThrow();
  });
});
