import { isRecord, type ValuePath } from '@servicerouter/common';

import type { IssueDraft } from '../validation/issues.js';

// SR-9: fields reserved for later fail with "not supported yet". They're never silently ignored, and
// the generic "unknown field" error for them is replaced by this one.
const reservedUpstreamTypes = ['mcp', 'graphql', 'websocket', 'grpc'];
const perUnitPriceFields = ['type', 'unitPrice', 'quantity', 'maxQuantity'];

const checkPayment = (payment: unknown, path: ValuePath, drafts: IssueDraft[]): void => {
  if (!isRecord(payment))
    return;

  for (const field of perUnitPriceFields) {
    if (field in payment)
      drafts.push({ path: [...path, field], message: 'per-unit prices are not supported yet', key: true });
  }
  if ('chargeOn' in payment)
    drafts.push({ path: [...path, 'chargeOn'], message: 'chargeOn is not supported yet', key: true });
};

/** Finds reserved fields in a raw document, before schema validation. */
export const findReservedFields = (value: Record<string, unknown>): readonly IssueDraft[] => {
  const drafts: IssueDraft[] = [];
  const { upstreams, payments, routes } = value;

  if (Array.isArray(upstreams)) {
    for (const [index, upstream] of upstreams.entries()) {
      const type = isRecord(upstream) ? upstream['type'] : undefined;
      if (typeof type === 'string' && reservedUpstreamTypes.includes(type))
        drafts.push({ path: ['upstreams', index, 'type'], message: `upstream type ${JSON.stringify(type)} is not supported yet` });
    }
  }

  if (isRecord(payments)) {
    for (const [name, payment] of Object.entries(payments))
      checkPayment(payment, ['payments', name], drafts);
  }

  if (isRecord(routes)) {
    for (const [key, route] of Object.entries(routes)) {
      if (!isRecord(route))
        continue;
      if ('rules' in route)
        drafts.push({ path: ['routes', key, 'rules'], message: 'rules are not supported yet', key: true });
      if ('chargeOn' in route)
        drafts.push({ path: ['routes', key, 'chargeOn'], message: 'chargeOn is not supported yet', key: true });
      checkPayment(route['payment'], ['routes', key, 'payment'], drafts);
    }
  }

  return drafts;
};
