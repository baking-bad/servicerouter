// WB-12: the Content-Security-Policy every page gets. Scripts run only from the site with this
// request's nonce, nothing third-party loads, and the browser talks only to the site and the Platform
// API: the console holds a master key (WB-8).

export interface CspOptions {
  readonly nonce: string;
  readonly apiUrl: string;
  // `next dev` needs eval and its websocket
  readonly development: boolean;
}

export const contentSecurityPolicy = ({ nonce, apiUrl, development }: CspOptions): string => [
  'default-src \'self\'',
  `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? ' \'unsafe-eval\'' : ''}`,
  'style-src \'self\' \'unsafe-inline\'',
  'img-src \'self\' data: blob:',
  'font-src \'self\'',
  `connect-src 'self' ${new URL(apiUrl).origin}${development ? ' ws:' : ''}`,
  'frame-ancestors \'none\'',
  'base-uri \'self\'',
  'form-action \'self\'',
  'object-src \'none\'',
].join('; ');

/** A fresh nonce for one response: 128 random bits, base64. */
export const createNonce = (): string => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));

/** Headers every response carries, beside the CSP (WB-12). */
export const securityHeaders: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};
