import { ServiceRouterError, type ValidationIssue } from '@servicerouter/common';

/** A submitted config fails validation (SR-2, PA-3). Carries every problem, and the warnings. */
export class InvalidServiceConfigError extends ServiceRouterError {
  readonly code = 'invalid_config';
  readonly issues: readonly ValidationIssue[];
  readonly warnings: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[], warnings: readonly ValidationIssue[] = []) {
    super(`The config has ${issues.length === 1 ? '1 problem' : `${issues.length} problems`}. Fix every one in details and submit it again`);

    this.issues = issues;
    this.warnings = warnings;
  }
}

/** `service.id` in the config isn't the ID in the URL. */
export class ServiceIdMismatchError extends ServiceRouterError {
  readonly code = 'service_id_mismatch';

  constructor() {
    super('service.id in the config must equal the service ID in the URL. A service ID never changes');
  }
}

/** The service belongs to another account. */
export class ServiceForbiddenError extends ServiceRouterError {
  readonly code = 'forbidden';

  constructor() {
    super('The service belongs to another account');
  }
}

/** No such service, or no such revision of it. */
export class ServiceNotFoundError extends ServiceRouterError {
  readonly code = 'not_found';
}

const quoteNames = (names: readonly string[]): string => names.map(name => JSON.stringify(name)).join(', ');

/** A secret sent or written that the config doesn't use, so it has no origin to be bound to (SC-10). */
export class UnusedSecretError extends ServiceRouterError {
  readonly code = 'unused_secret';
  readonly names: readonly string[];

  constructor(names: readonly string[], where = 'the config') {
    super(`No upstream in ${where} uses ${names.length === 1 ? 'the secret' : 'the secrets'} ${quoteNames(names)}, `
      + 'so there is no host to bind it to. Send a secret only with a config that uses it');

    this.names = names;
  }
}

/** Activating would send stored secrets to another host than the one they're sealed for (SC-10). */
export class SecretOriginMismatchError extends ServiceRouterError {
  readonly code = 'secret_origin_mismatch';
  readonly names: readonly string[];

  constructor(names: readonly string[]) {
    super(`The revision sends ${names.length === 1 ? 'the secret' : 'the secrets'} ${quoteNames(names)} to another host than `
      + `${names.length === 1 ? 'it is' : 'they are'} sealed for. Submit the config with ${names.length === 1 ? 'it' : 'them'} again instead`);

    this.names = names;
  }
}
