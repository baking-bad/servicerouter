import { describe, expect, it } from 'vitest';

import { formatIssue, InvalidAmountError, ValidationError } from '../src/index.js';

describe('errors (CK-2)', () => {
  it('carry a stable code and serialize without a stack', () => {
    const error = new InvalidAmountError('bad amount');

    expect(error.code).toBe('invalid_amount');
    expect(error.name).toBe('InvalidAmountError');
    expect(error.toJSON()).toEqual({ name: 'InvalidAmountError', code: 'invalid_amount', message: 'bad amount' });
    expect(JSON.stringify(error)).not.toContain('at ');
  });

  it('list validation issues in the message and in JSON', () => {
    const issues = [
      { path: '/service/id', message: 'has an invalid format', line: 5, column: 7 },
      { path: '', message: 'missing required field "payments"', source: 'a.yaml', line: 1, column: 1 },
    ];
    const error = new ValidationError('Invalid service config', issues);

    expect(error.code).toBe('validation_failed');
    expect(error.message).toBe('Invalid service config\n\t1. /service/id: has an invalid format (5:7)\n\t2. /: missing required field "payments" (a.yaml:1:1)');
    expect(error.toJSON()).toMatchObject({ code: 'validation_failed', issues });
  });

  it('formats an issue without a position', () => {
    expect(formatIssue({ path: '/a', message: 'is invalid' })).toBe('/a: is invalid');
  });
});
