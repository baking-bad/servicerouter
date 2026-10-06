import { logoSvg } from '../../src/logo';

// The SVG favicon (WB-9): the mark from the one copy of its paths
export const GET = (): Response => new Response(logoSvg(), {
  headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' },
});
