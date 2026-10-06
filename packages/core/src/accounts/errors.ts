import { ServiceRouterError } from '@servicerouter/common';

/** No credential: the request has no `Authorization: Bearer` key (PA-2). */
export class UnauthorizedError extends ServiceRouterError {
  readonly code = 'unauthorized';

  constructor() {
    super('This endpoint needs a master key: Authorization: Bearer <key>');
  }
}

/** An unknown, revoked, or malformed key. The message never says which (AK-4). */
export class InvalidKeyError extends ServiceRouterError {
  readonly code = 'invalid_key';

  constructor() {
    super('The key is invalid or revoked');
  }
}

/** A key of the other kind. Each kind works on one host only (AK-4). */
export class WrongKeyTypeError extends ServiceRouterError {
  readonly code = 'wrong_key_type';

  constructor(message: string) {
    super(message);
  }
}
