import { isMocked, type SiteSettings } from '../config';
import { sampleTopup } from '../mocks/topup';
import { ApiError, callApi } from './http';
import type { Sourced, Topup } from './types';

// The top-up data (DP-5): GET /v1/topup/{token}, or sample data until step 9 (WB-10).

const tokenPattern = /^[A-Za-z0-9_-]{1,128}$/;

/** The deposit address and recent deposits for a top-up token, or undefined for an unknown token. */
export const getTopup = async (settings: SiteSettings, token: string): Promise<Sourced<Topup> | undefined> => {
  if (!tokenPattern.test(token))
    return undefined;
  if (isMocked(settings, 'topup'))
    return { value: sampleTopup(token), sample: true };

  try {
    return { value: await callApi<Topup>(settings.apiUrl, { path: `/v1/topup/${token}` }), sample: false };
  }
  catch (error) {
    if (error instanceof ApiError && error.status === 404)
      return undefined;
    throw error;
  }
};
