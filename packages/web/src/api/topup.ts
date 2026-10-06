import { isMocked, type SiteSettings } from '../config';
import { sampleTopup } from '../mocks/topup';
import { ApiError, callApi } from './http';
import { logApiFailure } from './failures';
import type { Sourced, Topup } from './types';

// The top-up data (DP-5): GET /v1/topup/{token}, or sample data for a sample link while the `topup`
// group is on (WB-10).

const tokenPattern = /^[A-Za-z0-9_-]{1,128}$/;
// A token as the Platform API issues it: 24 random bytes, base64url (AK-15)
const issuedTokenPattern = /^[A-Za-z0-9_-]{32}$/;

/** The deposit address and recent deposits for a top-up token, or undefined for an unknown token. */
export const getTopup = async (settings: SiteSettings, token: string): Promise<Sourced<Topup> | undefined> => {
  if (!tokenPattern.test(token))
    return undefined;
  // A real link always reads the API, so a buyer never sees a sample address for their account
  if (isMocked(settings, 'topup') && !issuedTokenPattern.test(token))
    return { value: sampleTopup(token), sample: true };

  try {
    // The token opens a buyer's top-up page: the log names the route, never the token (L-10)
    return { value: await callApi<Topup>(settings.apiUrl, { path: `/v1/topup/${token}`, onFailure: logApiFailure('/v1/topup/{token}') }), sample: false };
  }
  catch (error) {
    if (error instanceof ApiError && error.status === 404)
      return undefined;
    throw error;
  }
};
