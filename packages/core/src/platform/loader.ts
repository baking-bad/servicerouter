import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  isRecord, maxDocumentBytes, parseStrictYaml, ServiceRouterError, type StrictYamlDocument,
} from '@servicerouter/common';

import { createDocumentLocator } from '../validation/issues.js';
import { assertValidPlatformConfigDocument, buildPlatformConfig } from './builder.js';
import type { PlatformConfig } from './config.js';
import type { PlatformConfigDocument } from './document.js';

const canonicalBase64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class ConfigLoadError extends ServiceRouterError {
  readonly code = 'config_load_failed';
}

export interface ConfigEnvironment {
  readonly [key: string]: string | undefined;
  // Comma-separated files, merged left to right
  readonly CONFIG_PATH?: string;
  // A final override, merged last. Canonical base64 of YAML or JSON, unless CONFIG_DECODE is false.
  readonly CONFIG?: string;
  readonly CONFIG_DECODE?: string;
}

export interface LoadPlatformConfigOptions {
  readonly env?: ConfigEnvironment;
  readonly cwd?: string;
}

const parseDecodeFlag = (value: string | undefined): boolean => {
  if (value === undefined)
    return true;

  const normalizedValue = value.trim().toLowerCase();
  if (normalizedValue === 'true' || normalizedValue === '1')
    return true;
  if (normalizedValue === 'false' || normalizedValue === '0')
    return false;

  throw new ConfigLoadError('CONFIG_DECODE must be one of: true, false, 1, 0');
};

const readInlineConfig = (rawConfig: string, decode: boolean): StrictYamlDocument => {
  if (!decode)
    return parseStrictYaml(rawConfig, { source: 'CONFIG' });

  if (!canonicalBase64Pattern.test(rawConfig))
    throw new ConfigLoadError('CONFIG is not valid canonical base64');

  const bytes = Buffer.from(rawConfig, 'base64');
  if (bytes.toString('base64') !== rawConfig)
    throw new ConfigLoadError('CONFIG is not valid canonical base64');

  return parseStrictYaml(bytes, { source: 'CONFIG' });
};

const readConfigFile = async (configPath: string, cwd: string): Promise<StrictYamlDocument> => {
  const resolvedPath = path.resolve(cwd, configPath);
  let bytes: Buffer;
  try {
    const fileStats = await stat(resolvedPath);
    if (!fileStats.isFile())
      throw new Error('the path does not reference a regular file');
    if (fileStats.size > maxDocumentBytes)
      throw new Error(`the file exceeds the ${maxDocumentBytes}-byte size limit`);

    bytes = await readFile(resolvedPath);
  }
  catch (error) {
    throw new ConfigLoadError(`Failed to load the config file ${resolvedPath}`, { cause: error });
  }

  // Syntax errors name the file and position
  return parseStrictYaml(bytes, { source: configPath });
};

const parseConfigPaths = (value: string): readonly string[] => {
  const paths = value.split(',').map(configPath => configPath.trim());
  if (paths.some(configPath => !configPath))
    throw new ConfigLoadError('CONFIG_PATH must contain one or more comma-separated paths');

  return paths;
};

const loadSources = async (env: ConfigEnvironment, cwd: string): Promise<readonly StrictYamlDocument[]> => {
  const { CONFIG_PATH: configPaths, CONFIG: inlineConfig } = env;
  const decode = parseDecodeFlag(env.CONFIG_DECODE);

  if (configPaths === undefined && inlineConfig === undefined)
    throw new ConfigLoadError('At least one of CONFIG_PATH or CONFIG must be set');
  if (inlineConfig !== undefined && !inlineConfig.trim())
    throw new ConfigLoadError('CONFIG must not be empty');

  const files = configPaths === undefined
    ? []
    : await Promise.all(parseConfigPaths(configPaths).map(configPath => readConfigFile(configPath, cwd)));

  return inlineConfig === undefined ? files : [...files, readInlineConfig(inlineConfig, decode)];
};

// Objects merge by key; every other value, lists included, replaces
const merge = (base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> => {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, overrideValue] of Object.entries(override)) {
    const baseValue = base[key];
    merged[key] = isRecord(baseValue) && isRecord(overrideValue) ? merge(baseValue, overrideValue) : overrideValue;
  }

  return merged;
};

const loadDocument = async (options: LoadPlatformConfigOptions = {}) => {
  const env = options.env ?? process.env;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const sources = await loadSources(env, cwd);
  const value = sources.map(source => source.value).reduce(merge);
  const locator = createDocumentLocator(sources);
  assertValidPlatformConfigDocument(value, locator);

  return { document: value, locator };
};

/**
 * Loads the platform config document from CONFIG_PATH and CONFIG, and validates its shape.
 * Throws ConfigLoadError, DocumentError, or ValidationError.
 */
export const loadPlatformConfigDocument = async (options?: LoadPlatformConfigOptions): Promise<PlatformConfigDocument> =>
  (await loadDocument(options)).document;

/** Loads, validates, and builds the platform config. An app with an invalid config doesn't start (PC-1). */
export const loadPlatformConfig = async (options?: LoadPlatformConfigOptions): Promise<PlatformConfig> => {
  const { document, locator } = await loadDocument(options);

  return buildPlatformConfig(document, locator);
};
