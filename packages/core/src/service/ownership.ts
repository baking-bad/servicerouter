import { serviceStateFor, type HostState } from '../ownership/state.js';
import type { ServiceConfigDocument } from './document.js';
import type { ServiceState } from './runtime.js';

export interface OwnershipStatusInput {
  // Hosts are verified per account (OV-1, OV-3)
  readonly accountId: string;
  // Each upstream's hostname, once. Every host is verified on its own (OV-3).
  readonly hosts: readonly string[];
}

/** Port: Ownership verification's answer for the hosts of a service (SR-8, OV-4, OV-5). */
export interface OwnershipStatus {
  /** The state of each host that has one. A host without a state is `unverified`. */
  hostStates(input: OwnershipStatusInput): Promise<ReadonlyMap<string, HostState>>;
}

/**
 * Every host counts as verified, so an activated service is `live`. The step 2 adapter (S2-D1), kept for
 * tests that aren't about ownership. Production wires the `upstream_hosts` adapter.
 */
export const assumeHostsVerified: OwnershipStatus = Object.freeze({
  hostStates: async ({ hosts }: OwnershipStatusInput) => new Map(hosts.map(host => [host, 'verified' as const])),
});

/** The upstream hosts of a config, once each, in config order (OV-3). */
export const getUpstreamHosts = (config: ServiceConfigDocument): readonly string[] =>
  [...new Set(config.upstreams.map(upstream => new URL(upstream.baseUrl).hostname))];

/**
 * The state a revision activates in (SR-8): `suspended` while any upstream host is, `live` once every
 * host is verified or in its grace period, `pending` until then.
 */
export const stateForActivation = async (ownership: OwnershipStatus, accountId: string, config: ServiceConfigDocument): Promise<ServiceState> => {
  const hosts = getUpstreamHosts(config);
  const states = await ownership.hostStates({ accountId, hosts });

  return serviceStateFor(hosts.map(host => states.get(host)));
};
