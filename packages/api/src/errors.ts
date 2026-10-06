import type { ErrorStatusTable } from '@servicerouter/common';

// Every ServiceRouterError code the Platform API answers with, and its status (CK-2, PA-3). A code
// missing here answers an opaque 500. Endpoints add their codes as they arrive.
export const errorStatuses = {
  // PA-2, AK-4
  unauthorized: 401,
  invalid_key: 401,
  wrong_key_type: 401,
  // PA-5
  rate_limited: 429,
} as const satisfies ErrorStatusTable;
