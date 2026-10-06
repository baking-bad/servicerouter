import { NextResponse, type NextRequest } from 'next/server';

import { readSettings } from './src/config';
import { hasMarkdown, markdownRoute, pageForMarkdownUrl, prefersMarkdown } from './src/markdown/negotiate';
import { contentSecurityPolicy, createNonce, securityHeaders } from './src/security/csp';

/**
 * Every request but static files: the Markdown version of a page (WB-11) for `<page>.md` or
 * `Accept: text/markdown`, and on everything else the CSP with a fresh nonce (WB-12). Next.js adds the
 * nonce to its own scripts when it finds it in the request's CSP.
 */
export const proxy = (request: NextRequest): NextResponse => {
  const { pathname } = request.nextUrl;
  const page = pageForMarkdownUrl(pathname) ?? (hasMarkdown(pathname) && prefersMarkdown(request.headers.get('accept')) ? pathname : undefined);
  if (page !== undefined) {
    const url = request.nextUrl.clone();
    url.pathname = markdownRoute(page);
    const response = NextResponse.rewrite(url);
    response.headers.set('vary', 'Accept');
    for (const [name, value] of Object.entries(securityHeaders))
      response.headers.set(name, value);

    return response;
  }

  const nonce = createNonce();
  const policy = contentSecurityPolicy({ nonce, apiUrl: readSettings().apiUrl, development: process.env.NODE_ENV === 'development' });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', policy);
  if (hasMarkdown(pathname))
    response.headers.set('vary', 'Accept');
  for (const [name, value] of Object.entries(securityHeaders))
    response.headers.set(name, value);

  return response;
};

export const config = {
  matcher: [{ source: '/((?!_next/static|_next/image).*)' }],
};
