export { SecretBindingInvalidError, SecretKeyInvalidError, SecretOpenFailedError, sealedSecretVersion } from './ports.js';
export type { OpenSecretInput, SealedSecret, SealSecretInput, SecretOpener, SecretSealer } from './ports.js';
export { deriveKeyId, minimumKeyBits } from './keys.js';
export { createSecretOpener, createSecretSealer, encodeAssociatedData } from './envelope.js';
export type { AssociatedDataInput } from './envelope.js';
export { assertValidBinding, findBindingProblem, isHttpsOrigin, isSecretName, secretNamePattern } from './binding.js';
export type { SecretBinding } from './binding.js';
