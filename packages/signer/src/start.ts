import { createKeyPairSignerFromBytes, getBase58Encoder, type KeyPairSigner } from '@solana/kit';
import { privateKeyToAccount } from 'viem/accounts';

import {
  formatUsd, InvalidEnvironmentError, readCommit, readHost, readLogLevel, readPort, readSecret, type AppContext, type AppEnvironment, type RunningApp,
  type Secret,
} from '@servicerouter/common';
import { loadPlatformConfig, platformSummary, readSolanaRpc, type PlatformConfig } from '@servicerouter/core';
import { createPostgres, createRedis } from '@servicerouter/db';

import { createApp } from './app.js';

export const defaultPort = 8083;
export const defaultMetricsPort = 9083;
// Long enough that guessing it over the network is hopeless
export const minimumSignerSecretLength = 32;

const readSignerSecret = (env: AppEnvironment): Secret => {
  const secret = readSecret('SIGNER_SECRET', env);
  if (secret.expose().length < minimumSignerSecretLength) {
    secret.destroy();
    throw new InvalidEnvironmentError(`SIGNER_SECRET must be at least ${minimumSignerSecretLength} characters`);
  }

  return secret;
};

/**
 * A hot wallet's private key, `0x` and 64 hex characters (SG-1): SIGNER_BASE_KEY for Base, SIGNER_TEMPO_KEY
 * for Tempo. Optional: without it, nothing is paid on that chain. One key may serve both: the address is
 * the same on each.
 */
const readWallet = (env: AppEnvironment, name: 'SIGNER_BASE_KEY' | 'SIGNER_TEMPO_KEY') => {
  if (!env[name]?.trim())
    return undefined;
  const key = readSecret(name, env);
  try {
    const value = key.expose().trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(value))
      throw new InvalidEnvironmentError(`${name} must be 0x and 64 hex characters`);

    return privateKeyToAccount(value as `0x${string}`);
  }
  finally {
    key.destroy();
  }
};

// A Solana secret key: 32 bytes of seed, then the 32 bytes of its public key
const solanaKeyLength = 64;

/** The 64 bytes of SIGNER_SOLANA_KEY: base58, as Phantom and Solflare export it, or a JSON array of numbers, as `solana-keygen` writes it. */
const solanaKeyBytes = (value: string): Uint8Array | undefined => {
  try {
    if (value.startsWith('[')) {
      const numbers = JSON.parse(value) as unknown;

      return Array.isArray(numbers) && numbers.every((item: unknown) => typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 255)
        ? Uint8Array.from(numbers as number[])
        : undefined;
    }

    return Uint8Array.from(getBase58Encoder().encode(value));
  }
  catch {
    return undefined;
  }
};

/**
 * The Solana hot wallet (SG-1), from SIGNER_SOLANA_KEY. Optional: without it, nothing is paid on Solana.
 * Its address must be `signer.wallets.solana` when that's set, or the balance monitor watches another
 * wallet. Neither the key nor its bytes reach an error.
 */
const readSolanaWallet = async (env: AppEnvironment, config: PlatformConfig): Promise<KeyPairSigner | undefined> => {
  if (!env['SIGNER_SOLANA_KEY']?.trim())
    return undefined;
  const key = readSecret('SIGNER_SOLANA_KEY', env);
  const bytes = solanaKeyBytes(key.expose().trim());
  key.destroy();
  if (bytes?.length !== solanaKeyLength) {
    bytes?.fill(0);
    throw new InvalidEnvironmentError('SIGNER_SOLANA_KEY must be a 64-byte Solana secret key: base58, or a JSON array of 64 numbers');
  }
  let wallet: KeyPairSigner;
  try {
    wallet = await createKeyPairSignerFromBytes(bytes);
  }
  catch {
    throw new InvalidEnvironmentError('SIGNER_SOLANA_KEY is not a valid Solana key pair: its last 32 bytes must be the public key of its first 32');
  }
  finally {
    bytes.fill(0);
  }
  const configured = config.signer.wallets.solana;
  if (configured !== undefined && configured !== wallet.address)
    throw new InvalidEnvironmentError(`SIGNER_SOLANA_KEY's address, ${wallet.address}, isn't signer.wallets.solana, ${configured}`);

  return wallet;
};

/**
 * Wires the production dependencies from platform config and the environment, then listens (SG-1,
 * SG-2). The hot wallets' keys come from the stack's secrets. The spend counters use the Signer's own
 * Redis ACL user, from REDIS_URL (SG-5).
 */
export const startSigner = async ({ env, logger }: AppContext): Promise<RunningApp> => {
  const config = await loadPlatformConfig({ env });
  // LOG_LEVEL overrides the config's level (L-11)
  logger.level = readLogLevel(env, config.logger.level);
  const listen = {
    host: readHost(env),
    port: readPort(env, 'PORT', defaultPort),
    metricsPort: readPort(env, 'METRICS_PORT', defaultMetricsPort),
  };
  const secret = readSignerSecret(env);
  const base = readWallet(env, 'SIGNER_BASE_KEY');
  const tempo = readWallet(env, 'SIGNER_TEMPO_KEY');
  const solana = await readSolanaWallet(env, config);
  if (!base && !tempo && !solana)
    logger.warn('The Signer has no wallet: SIGNER_BASE_KEY, SIGNER_TEMPO_KEY, and SIGNER_SOLANA_KEY are not set, so routed payments are refused');
  // Solana targets: SOLANA_RPC_URL, which may carry a key in its path. Only its host is logged.
  const solanaRpc = solana ? readSolanaRpc(env, config) : undefined;
  if (solanaRpc?.public)
    logger.warn({ host: solanaRpc.host }, 'SOLANA_RPC_URL is not set: the Signer builds Solana payments through the public RPC, which is rate limited');
  const databaseUrl = readSecret('DATABASE_URL', env);
  const redisUrl = readSecret('REDIS_URL', env);

  const postgres = createPostgres({ url: databaseUrl, logger });
  const redis = createRedis({ url: redisUrl, logger });
  const closeConnections = async () => {
    await Promise.all([postgres.close(), redis.close()]);
  };
  const server = createApp({
    config, logger, postgres, redis, secret, wallets: { ...base ? { base } : {}, ...tempo ? { tempo } : {}, ...solana ? { solana } : {} },
    ...solanaRpc ? { solanaRpcUrl: solanaRpc.url } : {},
  });
  let ports;
  try {
    ports = await server.listen(listen);
  }
  catch (error) {
    await closeConnections();
    throw error;
  }
  // L-1: once, what this Signer pays with. The wallets' public addresses, never their keys, and the Solana RPC's host only.
  const { signer } = config;
  logger.info({
    app: 'signer',
    commit: readCommit(env) ?? null,
    logLevel: logger.level,
    environment: platformSummary(config).environment,
    wallets: { base: base?.address ?? null, tempo: tempo?.address ?? null, solana: solana?.address ?? null },
    solanaRpc: solanaRpc?.host ?? null,
    limits: {
      maxPerCall: formatUsd(signer.maxPerCall),
      maxPerNetworkPerHour: signer.maxPerNetworkPerHour === undefined ? null : formatUsd(signer.maxPerNetworkPerHour),
      maxPerNetworkPerDay: formatUsd(signer.maxPerNetworkPerDay),
    },
    ports,
  }, 'Started');

  return {
    close: async () => {
      await server.close();
      await closeConnections();
    },
  };
};
