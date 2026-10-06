import type { SchemaObject } from 'ajv';

import { serviceIdPattern } from '@servicerouter/common';

import {
  array, boolean, constant, email, httpsUrl, map, object, oneOfValues, singleLine, text, usdAmount,
} from '../validation/schema.js';

export const httpMethods = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

// Upstream, credential, and payment names. `/` can't appear, so `<upstream>/<operationId>` splits cleanly.
const name: SchemaObject = {
  type: 'string', pattern: '^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$',
  errorMessage: 'must be 1–32 lowercase letters, digits, or hyphens, starting and ending with a letter or digit',
};
const secretName: SchemaObject = {
  type: 'string', pattern: '^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$',
  errorMessage: 'must be a secret name: 1–64 lowercase letters, digits, hyphens, or underscores. Send the value in the request\'s secrets, never in the config',
};
// `{param}` segments allowed; no query or fragment
const pathTemplatePattern = '/(?:[^{}?#\\s]|\\{[A-Za-z0-9_.~-]+\\})*';
const pathTemplateMessage = 'must be a path starting with "/", with {parameters} and without a query or fragment';
const pathTemplate: SchemaObject = {
  type: 'string', maxLength: 1024, pattern: `^${pathTemplatePattern}$`, errorMessage: pathTemplateMessage,
};
const paymentFields = { amount: usdAmount };
const payment = object(paymentFields);
const credentialReference: SchemaObject = {
  type: ['string', 'array'],
  if: { type: 'string' },
  then: name,
  else: array(name, { minItems: 1, uniqueItems: true }),
};

const operation: SchemaObject = {
  type: 'object',
  properties: {
    operationId: text(256),
    summary: { type: 'string', maxLength: 1024 },
    description: { type: 'string', maxLength: 100_000 },
    deprecated: boolean,
    tags: array({ type: 'string' }),
    parameters: array({ type: 'object' }),
    requestBody: { type: 'object' },
    responses: { type: 'object' },
  },
  // The rest of an OpenAPI operation object follows the OpenAPI spec, not this platform
  additionalProperties: true,
};
const pathItem: SchemaObject = {
  ...object({
    summary: { type: 'string', maxLength: 1024 },
    description: { type: 'string', maxLength: 100_000 },
    parameters: array({ type: 'object' }),
    servers: array({ type: 'object' }),
    ...Object.fromEntries(httpMethods.map(method => [method, operation])),
  }),
  patternProperties: { '^x-': {} },
};
// An inline OpenAPI `paths` object. `x-` extensions are allowed and ignored.
const paths: SchemaObject = map(
  { type: 'string', maxLength: 1024, pattern: `^(?:${pathTemplatePattern}|x-.*)$`, errorMessage: pathTemplateMessage },
  pathItem,
  { minProperties: 1, patternProperties: { '^x-': {} } },
);

const credential: SchemaObject = {
  type: 'object',
  discriminator: { propertyName: 'type' },
  properties: { type: { type: 'string' } },
  required: ['type'],
  oneOf: [
    object({
      type: constant('http'),
      scheme: oneOfValues(['bearer', 'basic']),
      secret: secretName,
    }, ['type', 'scheme', 'secret']),
    object({
      type: constant('apiKey'),
      in: oneOfValues(['header', 'query', 'cookie']),
      name: text(128),
      secret: secretName,
    }, ['type', 'in', 'name', 'secret'], {
      allOf: [
        {
          if: { properties: { in: { const: 'header' } } },
          then: { properties: { name: { type: 'string', format: 'header-name' } } },
        },
        {
          if: { properties: { in: { const: 'query' } } },
          then: { properties: { name: { type: 'string', pattern: '^[A-Za-z0-9._~-]+$', errorMessage: 'must be a query parameter name: letters, digits, ".", "_", "~", or "-"' } } },
        },
        {
          if: { properties: { in: { const: 'cookie' } } },
          then: { properties: { name: { type: 'string', pattern: '^[!#$%&\'*+.^_`|~0-9A-Za-z-]+$', errorMessage: 'must be a valid cookie name' } } },
        },
      ],
    }),
  ],
};

export const serviceConfigSchema: SchemaObject = {
  $id: 'servicerouter-service-config-v1',
  ...object({
    servicerouter: object({
      version: { ...constant('1'), errorMessage: 'must be "1", the only config format version. Quote it: version: "1"' },
    }, ['version']),
    service: object({
      id: {
        type: 'string', pattern: serviceIdPattern,
        errorMessage: 'must be 1–64 lowercase letters, digits, or hyphens, starting and ending with a letter or digit',
      },
      title: singleLine(60),
      summary: singleLine(120),
      description: text(10_000),
      category: text(64),
      tags: array(singleLine(40), { maxItems: 20, uniqueItems: true }),
      links: object({ homepage: httpsUrl, docs: httpsUrl }),
      contact: object({ name: singleLine(100), url: httpsUrl, email }),
    }, ['id', 'title', 'description', 'category']),
    payouts: object({
      default: object({ asset: text(64), address: text(256) }, ['asset', 'address']),
    }, ['default']),
    payments: {
      ...map(name, payment),
      properties: { default: object(paymentFields, ['amount']) },
      required: ['default'],
    },
    upstreams: array(object({
      baseUrl: httpsUrl,
      name,
      type: constant('http'),
      openapi: httpsUrl,
      paths,
      auth: credentialReference,
    }, ['baseUrl'], {
      allOf: [{
        oneOf: [{ required: ['openapi'], properties: { openapi: {} } }, { required: ['paths'], properties: { paths: {} } }],
        errorMessage: 'set exactly one of "openapi" (a link to an OpenAPI document) or "paths" (inline OpenAPI paths)',
      }],
    }), { minItems: 1, maxItems: 20 }),
    routes: map(
      { type: 'string', pattern: '^\\S{1,256}$', errorMessage: 'must be an operationId, or <upstream>/<operationId>' },
      object({
        payment: {
          type: ['string', 'object'],
          if: { type: 'string' },
          then: name,
          else: payment,
        },
        target: object({ path: pathTemplate }, ['path']),
        enabled: boolean,
      }),
    ),
    credentials: map(name, credential),
  }, ['servicerouter', 'service', 'payouts', 'payments', 'upstreams']),
};
