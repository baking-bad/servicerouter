import type { ErrorStatusTable } from '@servicerouter/common';

// Every ServiceRouterError code the proxy answers with, and its status (CK-2). A code missing here
// answers an opaque 500. The proxy's codes arrive with its features.
export const errorStatuses = {} as const satisfies ErrorStatusTable;
