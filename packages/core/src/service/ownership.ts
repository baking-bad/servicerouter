import type { ServiceId } from '@servicerouter/common';

import type { ServiceConfigDocument } from './document.js';
import type { ServiceState } from './runtime.js';

export interface OwnershipStatusInput {
  readonly serviceId: ServiceId;
  // Each upstream's hostname, once. Every host is verified on its own (OV-3).
  readonly hosts: readonly string[];
}

/** Port: Ownership verification's answer for the hosts of a service (SR-8, OV-4, OV-5). */
export interface OwnershipStatus {
  /** Whether every one of these hosts is verified. */
  allHostsVerified(input: OwnershipStatusInput): Promise<boolean>;
}

/**
 * The step 2 adapter (S2-D1): every host counts as verified until Ownership verification ships in
 * step 8, so an activated service is `live`. Step 8 replaces it.
 */
export const assumeHostsVerified: OwnershipStatus = Object.freeze({
  allHostsVerified: async () => true,
});

/** The upstream hosts of a config, once each, in config order (OV-3). */
export const getUpstreamHosts = (config: ServiceConfigDocument): readonly string[] =>
  [...new Set(config.upstreams.map(upstream => new URL(upstream.baseUrl).hostname))];

/**
 * The state a revision activates in (SR-8): `live` once every upstream host is verified, `pending`
 * until then. `suspended` comes with ownership verification (step 8).
 */
export const stateForActivation = async (ownership: OwnershipStatus, serviceId: ServiceId, config: ServiceConfigDocument): Promise<ServiceState> =>
  await ownership.allHostsVerified({ serviceId, hosts: getUpstreamHosts(config) }) ? 'live' : 'pending';
