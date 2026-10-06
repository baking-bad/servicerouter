import { TextDecoder } from 'node:util';

import { isRecord, parseStrictYaml, Secret, type StrictYamlDocument, type ValidationIssue } from '@servicerouter/common';
import { fromPointer, isSecretName, type ServiceConfigSource, type SubmittedConfig } from '@servicerouter/core';

import { InvalidRequestError } from '../errors.js';

// A config may be up to 1 MiB (CK-8); the rest is room for its JSON envelope and secrets
export const submitBodyLimit = 2 * 1024 * 1024;
export const jsonMediaType = 'application/json';
export const yamlMediaTypes = ['application/yaml', 'application/x-yaml', 'text/yaml'] as const;
// The media type a YAML config is stored with
const yamlMediaType = 'application/yaml';
export const maxSecretLength = 8192;

// C0 controls and DEL: no credential an upstream takes holds them, and a header can't
const controlCharacter = /[\u0000-\u001F\u007F]/u;

/** A `PUT /v1/services/{id}` body, taken apart (SR-12, SC-9). */
export interface SubmitBody {
  // What pass 1 reads: YAML or JSON text, or the envelope's config object
  readonly source: ServiceConfigSource;
  // The config as submitted, to keep in the revision
  readonly submitted: SubmittedConfig;
  // The envelope's secrets: a value to seal, or null to delete one. The caller destroys the values.
  readonly secrets: ReadonlyMap<string, Secret | null>;
  // Adds lines and columns to issues of a config object, from where it sits in the envelope
  readonly locate: (issues: readonly ValidationIssue[]) => readonly ValidationIssue[];
}

const asIs = (issues: readonly ValidationIssue[]): readonly ValidationIssue[] => issues;

const decodeUtf8 = (bytes: Buffer): string | undefined => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  catch {
    return undefined;
  }
};

/** The media type of a Content-Type header, lowercase, without parameters. */
export const mediaTypeOf = (contentType: string | undefined): string => (contentType ?? '').split(';')[0]!.trim().toLowerCase();

/** Why a secret value can't be stored, naming the secret and never quoting the value, or undefined. */
export const findSecretValueProblem = (name: string, value: unknown): string | undefined => {
  if (typeof value !== 'string')
    return `The secret "${name}" must be a string`;
  if (value === '')
    return `The secret "${name}" is empty`;
  if ([...value].length > maxSecretLength)
    return `The secret "${name}" is longer than ${maxSecretLength} characters`;
  if (controlCharacter.test(value))
    return `The secret "${name}" contains a control character, such as a line break`;

  return undefined;
};

// Every value goes into a Secret before anything else looks at it. A problem destroys those made so far.
const takeSecrets = (field: unknown): ReadonlyMap<string, Secret | null> => {
  const secrets = new Map<string, Secret | null>();
  if (field === undefined)
    return secrets;
  if (!isRecord(field))
    throw new InvalidRequestError('"secrets" must map secret names to values, or to null to delete one');

  try {
    for (const [name, value] of Object.entries(field)) {
      // Never echoed: a malformed key could be a value pasted in the wrong place
      if (!isSecretName(name))
        throw new InvalidRequestError('Every key of "secrets" must be a secret name: 1–64 lowercase letters, digits, hyphens, or underscores');
      if (value === null) {
        secrets.set(name, null);
        continue;
      }

      const problem = findSecretValueProblem(name, value);
      if (problem)
        throw new InvalidRequestError(typeof value === 'string' ? problem : `${problem}, or null to delete it`);
      secrets.set(name, Secret.from(value as string));
    }
  }
  catch (error) {
    for (const secret of secrets.values())
      secret?.destroy();
    throw error;
  }

  return secrets;
};

// Positions of issues in a config object come from the envelope text, under `config`
const locateInEnvelope = (text: string) => (issues: readonly ValidationIssue[]): readonly ValidationIssue[] => {
  if (issues.every(issue => issue.line !== undefined))
    return issues;

  let document: StrictYamlDocument;
  try {
    document = parseStrictYaml(text, { maxBytes: submitBodyLimit });
  }
  catch {
    // Only positions are lost. Nothing from this parse reaches a response.
    return issues;
  }

  return issues
    .map(issue => {
      const position = issue.line === undefined ? document.locate(['config', ...fromPointer(issue.path)]) : undefined;

      return position ? { ...issue, line: position.line, column: position.column } : issue;
    })
    .sort((left, right) => (left.line ?? Infinity) - (right.line ?? Infinity) || (left.column ?? 0) - (right.column ?? 0));
};

const parseJsonBody = (bytes: Buffer): SubmitBody => {
  const text = decodeUtf8(bytes);
  let value: unknown;
  try {
    value = text === undefined ? undefined : JSON.parse(text);
  }
  catch {
    value = undefined;
  }
  if (text === undefined || value === undefined)
    throw new InvalidRequestError('The request body is not valid JSON');

  // Any other JSON is the config itself, read as text so its issues get lines and columns
  if (!isRecord(value) || !Object.hasOwn(value, 'config'))
    return { source: text, submitted: { mediaType: jsonMediaType, text }, secrets: new Map(), locate: asIs };

  // The envelope (SR-12). Its secrets come out first, so nothing later can quote them (SC-9).
  const secrets = takeSecrets(value['secrets']);
  delete value['secrets'];
  const { config } = value;
  if (Object.keys(value).some(key => key !== 'config') || !(typeof config === 'string' || isRecord(config))) {
    for (const secret of secrets.values())
      secret?.destroy();
    throw new InvalidRequestError(Object.keys(value).some(key => key !== 'config')
      ? 'The envelope takes only "config" and "secrets"'
      : '"config" must be the config as YAML or JSON text, or as a JSON object');
  }

  return typeof config === 'string'
    ? { source: config, submitted: { mediaType: yamlMediaType, text: config }, secrets, locate: asIs }
    : { source: config, submitted: { mediaType: jsonMediaType, text: JSON.stringify(config, null, 2) }, secrets, locate: locateInEnvelope(text) };
};

/**
 * Takes a submit body apart (SR-12, SC-9):
 * - JSON with a top-level `config` is an envelope: `secrets` comes out first, each value in a Secret;
 *   `config` is YAML or JSON text, or a JSON object;
 * - other JSON is the config;
 * - `application/yaml`, `application/x-yaml`, and `text/yaml` are YAML text.
 * Throws InvalidRequestError for a body it can't take. Messages name secrets, never their values.
 */
export const parseSubmitBody = (body: unknown, contentType: string | undefined): SubmitBody => {
  if (!Buffer.isBuffer(body) || body.length === 0)
    throw new InvalidRequestError('The request has no config. Send it as YAML or JSON, or in a JSON envelope with its secrets');

  if (mediaTypeOf(contentType) === jsonMediaType)
    return parseJsonBody(body);

  // Invalid UTF-8 goes to pass 1 as bytes, which reports it as a config problem
  const text = decodeUtf8(body);

  return {
    source: text ?? body,
    submitted: { mediaType: yamlMediaType, text: text ?? '' },
    secrets: new Map(),
    locate: asIs,
  };
};
