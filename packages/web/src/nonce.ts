import { headers } from 'next/headers';

// The CSP nonce proxy.ts made for this request (WB-12). Reading it makes the page render per request,
// so every response gets its own nonce, and runtime settings are read per request too.
export const requestNonce = async (): Promise<string | undefined> => (await headers()).get('x-nonce') ?? undefined;
