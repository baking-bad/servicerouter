export const dynamic = 'force-dynamic';

// Liveness for the stack's health check (WB-6). The website has no dependency to check: a Platform API
// outage shows on the pages.
export const GET = (): Response => Response.json({ status: 'ok' }, { headers: { 'cache-control': 'no-store' } });
