import { InvalidEnvironmentError, type AppEnvironment } from '@servicerouter/common';
import { createDepositAddressDeriver, DepositKeyError, type DepositAddressDeriver, type PlatformConfig } from '@servicerouter/core';

export const depositKeyVariable = 'DEPOSIT_ACCOUNT_PUBLIC_KEY';

/**
 * DEPOSIT_ACCOUNT_PUBLIC_KEY, the HD wallet's account public key that deposit addresses derive from
 * (DP-1). Required while deposits are on; the API refuses to start without a usable one. It is public:
 * the mnemonic stays offline.
 */
export const readDepositAddresses = (env: AppEnvironment, deposits: NonNullable<PlatformConfig['deposits']>): DepositAddressDeriver => {
  const value = env[depositKeyVariable]?.trim();
  if (!value)
    throw new InvalidEnvironmentError(`${depositKeyVariable} is required while deposits are on (deposits in platform config)`);
  try {
    return createDepositAddressDeriver({ accountPublicKey: value, network: deposits.network });
  }
  catch (error) {
    if (error instanceof DepositKeyError)
      throw new InvalidEnvironmentError(`${depositKeyVariable}: ${error.message}`);
    throw error;
  }
};
