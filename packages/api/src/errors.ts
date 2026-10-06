import type { ErrorStatusTable } from '@servicerouter/common';

// Every ServiceRouterError code the Platform API answers with, and its status (CK-2, PA-3). A code
// missing here answers an opaque 500. Endpoints add their codes as they arrive.
export const errorStatuses = {} as const satisfies ErrorStatusTable;
