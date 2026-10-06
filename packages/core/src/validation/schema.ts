import { isIP } from 'node:net';
import { validateHeaderName } from 'node:http';

import { Ajv, type ErrorObject, type SchemaObject } from 'ajv';

import { usdAmountPattern } from '@servicerouter/common';

import { fromPointer, type IssueDraft } from './issues.js';

// Shared JSON Schema building blocks. Fixed objects never allow unknown fields.

export const object = (properties: Record<string, SchemaObject>, required: readonly string[] = [], extra: SchemaObject = {}): SchemaObject => ({
  type: 'object', properties, required, additionalProperties: false, ...extra,
});
export const array = (items: SchemaObject, extra: SchemaObject = {}): SchemaObject => ({ type: 'array', items, ...extra });
export const map = (keys: SchemaObject, values: SchemaObject, extra: SchemaObject = {}): SchemaObject => ({
  type: 'object', propertyNames: keys, additionalProperties: values, ...extra,
});
export const text = (maxLength: number, extra: SchemaObject = {}): SchemaObject => ({ type: 'string', minLength: 1, maxLength, ...extra });
export const singleLine = (maxLength: number): SchemaObject => text(maxLength, { pattern: '^[^\\r\\n]*$', errorMessage: `must be one line of at most ${maxLength} characters` });
export const oneOfValues = (values: readonly string[]): SchemaObject => ({ type: 'string', enum: values });
export const constant = (value: string | number): SchemaObject => ({ type: typeof value === 'number' ? 'integer' : 'string', const: value });
export const integer = (minimum: number, maximum?: number): SchemaObject => ({ type: 'integer', minimum, ...(maximum === undefined ? {} : { maximum }) });
export const boolean: SchemaObject = { type: 'boolean' };
export const usdAmount: SchemaObject = {
  type: 'string', pattern: usdAmountPattern, maxLength: 26,
  errorMessage: 'must be a USD amount as a string with at most 6 decimal places, such as "0.001"',
};
export const httpsUrl: SchemaObject = { type: 'string', maxLength: 2048, format: 'https-url' };
export const httpUrl: SchemaObject = { type: 'string', maxLength: 2048, format: 'http-url' };
export const httpsOrigin: SchemaObject = { type: 'string', maxLength: 2048, format: 'https-origin' };
export const email: SchemaObject = { type: 'string', maxLength: 254, format: 'email' };
export const host: SchemaObject = { type: 'string', maxLength: 253, format: 'host' };

const parseUrl = (value: string): URL | undefined => {
  try {
    return new URL(value);
  }
  catch {
    return undefined;
  }
};

const isUrl = (value: string, protocols: readonly string[]): boolean => {
  const url = parseUrl(value);

  return !!url && protocols.includes(url.protocol) && !url.username && !url.password && !url.hash;
};

const hostnameRegExp = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export const ajv = new Ajv({
  allErrors: true,
  verbose: true,
  strict: true,
  allowUnionTypes: true,
  discriminator: true,
});

// An annotation that replaces the generic message for the keyword errors of the schema it sits in
ajv.addKeyword('errorMessage');
ajv.addFormat('https-url', value => isUrl(value, ['https:']));
ajv.addFormat('http-url', value => isUrl(value, ['http:', 'https:']));
ajv.addFormat('https-origin', value => isUrl(value, ['https:']) && parseUrl(value)?.origin === value);
ajv.addFormat('email', value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
ajv.addFormat('host', value => isIP(value) !== 0 || hostnameRegExp.test(value));
ajv.addFormat('header-name', value => {
  try {
    validateHeaderName(value);

    return true;
  }
  catch {
    return false;
  }
});

const formatNames: Record<string, string> = {
  'https-url': 'an HTTPS URL without credentials or a fragment',
  'http-url': 'an HTTP or HTTPS URL without credentials or a fragment',
  'https-origin': 'an HTTPS origin, such as https://example.com, without a path or a trailing slash',
  'email': 'an email address',
  'host': 'a hostname or an IP address',
  'header-name': 'a valid HTTP header name',
};

const typeNames: Record<string, string> = {
  string: 'a string',
  object: 'an object',
  array: 'a list',
  integer: 'an integer',
  number: 'a number',
  boolean: 'true or false',
  null: 'null',
};

const describeType = (type: unknown): string => (Array.isArray(type) ? type : [type])
  .map(item => typeNames[String(item)] ?? String(item))
  .join(' or ');

const quote = (value: unknown): string => JSON.stringify(value);

// Keywords whose errors are about a child property, so the schema's own errorMessage doesn't apply
const structuralKeywords = new Set(['required', 'additionalProperties', 'if', 'discriminator', 'propertyNames']);

// A schema's errorMessage: one message for every error, or one per keyword, such as { type: '…' }
const customMessage = (error: ErrorObject): string | undefined => {
  const message: unknown = (error.parentSchema as SchemaObject | undefined)?.['errorMessage'];
  if (typeof message === 'string')
    return message;
  const forKeyword = typeof message === 'object' && message !== null ? (message as Record<string, unknown>)[error.keyword] : undefined;

  return typeof forKeyword === 'string' ? forKeyword : undefined;
};

const describeError = (error: ErrorObject): string => {
  const params = error.params as Record<string, unknown>;
  const custom = structuralKeywords.has(error.keyword) ? undefined : customMessage(error);
  if (custom)
    return custom;

  switch (error.keyword) {
    case 'type': return `must be ${describeType(params['type'])}`;
    case 'const': return `must be ${quote(params['allowedValue'])}`;
    case 'enum': return `must be one of: ${(params['allowedValues'] as unknown[]).map(quote).join(', ')}`;
    case 'pattern': return 'has an invalid format';
    case 'format': return `must be ${formatNames[String(params['format'])] ?? String(params['format'])}`;
    case 'minLength': return params['limit'] === 1 ? 'must not be empty' : `must be at least ${String(params['limit'])} characters`;
    case 'maxLength': return `must be at most ${String(params['limit'])} characters`;
    case 'minimum': return `must be at least ${String(params['limit'])}`;
    case 'maximum': return `must be at most ${String(params['limit'])}`;
    case 'minItems': return `must have at least ${String(params['limit'])} item${params['limit'] === 1 ? '' : 's'}`;
    case 'maxItems': return `must have at most ${String(params['limit'])} items`;
    case 'uniqueItems': return 'must not contain duplicates';
    case 'minProperties': return `must have at least ${String(params['limit'])} entr${params['limit'] === 1 ? 'y' : 'ies'}`;
    case 'maxProperties': return `must have at most ${String(params['limit'])} entries`;
    case 'oneOf':
    case 'anyOf': return 'does not match any allowed form';
    case 'not': return 'is not allowed';
    default: return error.message ?? 'is invalid';
  }
};

const discriminatorValues = (error: ErrorObject, tag: string): readonly unknown[] => {
  const variants: unknown = (error.parentSchema as SchemaObject | undefined)?.['oneOf'];

  return Array.isArray(variants)
    ? variants.map(variant => (variant as SchemaObject)['properties']?.[tag]?.const)
    : [];
};

const toDraft = (error: ErrorObject): IssueDraft | undefined => {
  const path = fromPointer(error.instancePath);
  const params = error.params as Record<string, unknown>;

  // A property name failed its propertyNames schema: report it once, on the key
  if (error.propertyName !== undefined)
    return { path: [...path, error.propertyName], message: customMessage(error) ?? 'is not a valid name', key: true };

  switch (error.keyword) {
    case 'propertyNames':
    case 'if':
      return undefined;
    case 'required':
      return { path, message: `missing required field ${quote(params['missingProperty'])}` };
    case 'additionalProperties':
      return { path: [...path, String(params['additionalProperty'])], message: 'unknown field', key: true };
    case 'discriminator': {
      const tag = String(params['tag']);

      return params['error'] === 'tag'
        ? { path, message: `missing required field ${quote(tag)}` }
        : { path: [...path, tag], message: `must be one of: ${discriminatorValues(error, tag).map(quote).join(', ')}` };
    }
    default:
      return { path, message: describeError(error) };
  }
};

/** Turns Ajv errors into readable issues. A oneOf or anyOf with an errorMessage hides its branches' errors. */
export const toSchemaDrafts = (errors: readonly ErrorObject[]): readonly IssueDraft[] => {
  const summarized = errors
    .filter(error => (error.keyword === 'oneOf' || error.keyword === 'anyOf') && customMessage(error))
    .map(error => `${error.schemaPath}/`);

  return errors
    .filter(error => !summarized.some(prefix => error.schemaPath.startsWith(prefix)))
    .map(toDraft)
    .filter(draft => draft !== undefined);
};
