import { isRecord } from '@servicerouter/common';

export const invalidationKinds = ['service', 'account', 'key'] as const;
export type InvalidationKind = typeof invalidationKinds[number];

/** A cached item changed: the Service registry (SR-7) and Accounts and keys (AK-9) publish these. */
export interface InvalidationEvent {
  readonly kind: InvalidationKind;
  readonly id: string;
}

export type InvalidationHandler = (event: InvalidationEvent) => void | Promise<void>;
export type Unsubscribe = () => Promise<void>;

/**
 * Port: tells every replica that a cached item changed. Delivery is best effort: a replica that is
 * disconnected when an event is published misses it, so caches still expire on their own.
 */
export interface InvalidationBus {
  publish(event: InvalidationEvent): Promise<void>;
  /** Resolves once the handler is subscribed: it receives every event published after that. */
  subscribe(handler: InvalidationHandler): Promise<Unsubscribe>;
}

// Extra fields are allowed, so a newer publisher can add some without breaking older subscribers
export const isInvalidationEvent = (value: unknown): value is InvalidationEvent =>
  isRecord(value)
  && invalidationKinds.includes(value['kind'] as InvalidationKind)
  && typeof value['id'] === 'string'
  && value['id'].length > 0;
