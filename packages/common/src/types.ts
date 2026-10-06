// Shared identifiers (CK-9). Patterns are strings so JSON Schemas can reuse them.

export type RequestId = string;
// [a-z0-9-], starting and ending with a letter or digit. Part of the pay URL, so never `.` or `_` first.
export type ServiceId = string;
// Asset registry entry name, such as `base-usdc`
export type AssetName = string;
// CAIP-2 chain ID, such as `eip155:8453` or `cardano:mainnet`
export type NetworkId = `${string}:${string}`;

export const requestIdPattern = '^[A-Za-z0-9._:-]{1,128}$';
export const serviceIdPattern = '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$';
export const assetNamePattern = '^[a-z0-9]+(?:-[a-z0-9]+)*$';
export const networkIdPattern = '^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$';

const requestIdRegExp = new RegExp(requestIdPattern);
const serviceIdRegExp = new RegExp(serviceIdPattern);
const assetNameRegExp = new RegExp(assetNamePattern);
const networkIdRegExp = new RegExp(networkIdPattern);

export const isRequestId = (value: string): value is RequestId => requestIdRegExp.test(value);
export const isServiceId = (value: string): value is ServiceId => serviceIdRegExp.test(value);
export const isAssetName = (value: string): value is AssetName => value.length <= 64 && assetNameRegExp.test(value);
export const isNetworkId = (value: string): value is NetworkId => networkIdRegExp.test(value);
