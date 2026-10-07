import {
  readCommit, readHost, readLogLevel, readPort, readSecret, systemClock, type AppContext, type RunningApp,
} from '@servicerouter/common';
import { createBlockfrostClient, findAsset, loadPlatformConfig, platformDefaults, platformSummary, readSolanaRpc, type PlatformConfig } from '@servicerouter/core';
import { createPostgres, createRedis } from '@servicerouter/db';
import { checkFacilitators, createFacilitators, createMppSettlementCheck, createTempoRpc, type MppSettlementCheck } from '@servicerouter/payments';

import { createApp } from './app.js';
import { createCardanoPayoutWallet } from './payouts/wallet.js';
import { createCardanoBalanceReader, createEvmBalanceReader, createSolanaBalanceReader } from './treasury/readers.js';

export const defaultMetricsPort = 9082;
// How long the facilitators get to answer /supported at startup, as for the proxy (PR-6), and the Tempo
// RPC its chain ID (PR-9)
export const facilitatorStartupTimeoutMs = 10_000;
// Each Blockfrost call of the deposit watcher
export const blockfrostTimeoutMs = 10_000;

// Public RPCs of the EVM networks the treasury reads (TR-3). EVM_RPC_URLS overrides them, and mpp.rpcUrl Tempo's.
const defaultEvmRpcUrls: Readonly<Record<string, string>> = {
  'eip155:8453': 'https://mainnet.base.org',
  'eip155:84532': 'https://sepolia.base.org',
  'eip155:4217': 'https://rpc.tempo.xyz',
  'eip155:42431': 'https://rpc.moderato.tempo.xyz',
};

/** `EVM_RPC_URLS`: `eip155:8453=https://…,eip155:4217=https://…`, without credentials. */
const readEvmRpcUrls = (env: Readonly<Record<string, string | undefined>>, config: PlatformConfig): ReadonlyMap<string, string> => new Map([
  ...Object.entries(defaultEvmRpcUrls),
  ...config.mpp.rpcUrl ? [[config.mpp.network.id, config.mpp.rpcUrl] as const] : [],
  ...(env['EVM_RPC_URLS'] ?? '').split(',').map(item => item.trim()).filter(Boolean).map(item => {
    const [network, url] = item.split('=') as [string, string | undefined];

    return [network, url ?? ''] as const;
  }),
]);

/** The Cardano network's Blockfrost: the deposits' URL on the same network, or Blockfrost's default. */
const blockfrostUrlFor = (config: PlatformConfig, networkId: string): string | undefined =>
  config.deposits?.network.id === networkId ? config.deposits.blockfrostUrl : platformDefaults.blockfrostUrls[networkId];

/** Wires the production dependencies from platform config and the environment, then listens. */
export const startWorkers = async ({ env, logger }: AppContext): Promise<RunningApp> => {
  const config = await loadPlatformConfig({ env });
  // LOG_LEVEL overrides the config's level (L-11)
  logger.level = readLogLevel(env, config.logger.level);
  const listen = {
    host: readHost(env),
    port: readPort(env, 'METRICS_PORT', defaultMetricsPort),
  };
  const databaseUrl = readSecret('DATABASE_URL', env);
  // The invalidation channel, for services an ownership check changes (OV-5)
  const redisUrl = readSecret('REDIS_URL', env);
  // The settlement follow-up repeats settles through the enabled facilitators (WK-6)
  const facilitators = createFacilitators({
    config,
    cdpApiKey: auth => ({ id: readSecret(auth.apiKeyId, env), secret: readSecret(auth.apiKeySecret, env) }),
    clock: systemClock,
  });
  // Every enabled facilitator answers /supported, or the workers don't start (PR-6)
  await checkFacilitators({ config, facilitators, timeoutMs: facilitatorStartupTimeoutMs });
  // While MPP is on, the follow-up reads receipts on the Tempo RPC, which must answer with mpp.network's
  // chain ID (PR-9, WK-6)
  let mppCheck: MppSettlementCheck | undefined;
  if (config.mpp.enabled) {
    const rpc = createTempoRpc({ network: config.mpp.network, url: config.mpp.rpcUrl });
    await rpc.check(facilitatorStartupTimeoutMs);
    mppCheck = createMppSettlementCheck({ rpc, timeoutMs: config.timeouts.connectMs, clock: systemClock });
  }

  // PO-8: the payout key, in the workers only. Without it, the payouts job doesn't run.
  const payoutAsset = config.payouts.assets[0] === undefined ? undefined : findAsset(config, config.payouts.assets[0]);
  const payoutMnemonic = env['PAYOUT_WALLET_MNEMONIC']?.trim() ? readSecret('PAYOUT_WALLET_MNEMONIC', env) : undefined;
  // DP-2, PO-3, TR-3: Blockfrost for the deposits' and payouts' Cardano network
  const cardanoNetwork = config.deposits?.network.id ?? payoutAsset?.network.id;
  const blockfrostUrl = cardanoNetwork === undefined ? undefined : blockfrostUrlFor(config, cardanoNetwork);
  const blockfrostProjectId = config.deposits || payoutMnemonic ? readSecret('BLOCKFROST_PROJECT_ID', env) : undefined;
  const blockfrost = blockfrostUrl && blockfrostProjectId
    ? createBlockfrostClient({ url: blockfrostUrl, projectId: blockfrostProjectId, timeoutMs: blockfrostTimeoutMs })
    : undefined;
  const payoutWallet = payoutMnemonic && payoutAsset && blockfrostUrl && blockfrostProjectId
    ? createCardanoPayoutWallet({ mnemonic: payoutMnemonic, asset: payoutAsset, blockfrost: { url: blockfrostUrl, projectId: blockfrostProjectId } })
    : undefined;
  if (!payoutWallet)
    logger.warn('Payouts are off: PAYOUT_WALLET_MNEMONIC is not set');
  const evmRpcUrls = readEvmRpcUrls(env, config);
  // TR-3, TR-5: Solana through SOLANA_RPC_URL, which may carry a key in its path
  const solanaRpc = readSolanaRpc(env, config);
  if (solanaRpc?.public)
    logger.warn({ host: solanaRpc.host }, 'SOLANA_RPC_URL is not set: the treasury reads Solana through its public RPC, which is rate limited');
  const balanceReaders = {
    ...blockfrost ? { cardano: createCardanoBalanceReader(blockfrost) } : {},
    evm: createEvmBalanceReader({ rpcUrlFor: network => evmRpcUrls.get(network), timeoutMs: blockfrostTimeoutMs }),
    ...solanaRpc ? { solana: createSolanaBalanceReader({ rpcUrl: solanaRpc.url, timeoutMs: blockfrostTimeoutMs }) } : {},
  };

  const postgres = createPostgres({ url: databaseUrl, logger });
  const redis = createRedis({ url: redisUrl, logger });
  const closeConnections = async () => {
    await Promise.all([postgres.close(), redis.close()]);
  };
  const server = createApp({
    config, logger, postgres, redis, facilitators, balanceReaders,
    ...(mppCheck ? { mppCheck } : {}), ...(blockfrost ? { blockfrost } : {}), ...(payoutWallet ? { payoutWallet } : {}),
  });
  let port;
  try {
    port = await server.listen(listen);
  }
  catch (error) {
    await closeConnections();
    throw error;
  }
  // L-1: once, what this replica runs. Network names and the Solana RPC's host only: an RPC URL can carry a key, so it stays out.
  logger.info({
    app: 'workers',
    commit: readCommit(env) ?? null,
    logLevel: logger.level,
    ...platformSummary(config),
    jobs: server.jobs,
    blockfrost: blockfrost !== undefined,
    payouts: payoutWallet !== undefined,
    settlementFollowUp: { facilitators: facilitators.map(facilitator => facilitator.name), mpp: mppCheck !== undefined },
    treasuryReaders: { cardano: balanceReaders.cardano !== undefined, evm: [...evmRpcUrls.keys()], solana: solanaRpc?.host ?? null },
    ports: { metricsPort: port },
  }, 'Started');

  return {
    close: async () => {
      await server.close();
      await closeConnections();
    },
  };
};
