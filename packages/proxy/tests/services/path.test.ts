import { describe, expect, it } from 'vitest';

import { InvalidPathError } from '../../src/errors.js';
import { parseServicePath } from '../../src/services/path.js';

describe('parseServicePath (PX-4)', () => {
  it('splits the service ID, the normalized segments after it, and the raw query', () => {
    expect(parseServicePath('/service/my-app/weather/oslo?units=metric&x=%2F')).toEqual({
      serviceId: 'my-app',
      segments: ['weather', 'oslo'],
      query: 'units=metric&x=%2F',
    });
  });

  it.each(['/service/my-app', '/service/my-app/', '/service/my-app?x=1'])('reads %s as the root path', target => {
    expect(parseServicePath(target).segments).toEqual(['']);
  });

  it('normalizes each segment the way template literals are stored (SR-5)', () => {
    expect(parseServicePath('/service/my%2Dapp/caf%c3%a9/%7Euser/a%2fb')).toMatchObject({
      serviceId: 'my-app',
      segments: ['caf%C3%A9', '~user', 'a%2Fb'],
    });
  });

  it.each([
    ['a raw dot', '/service/my-app/weather/./oslo'],
    ['a raw dot-dot', '/service/my-app/weather/../admin'],
    ['%2E%2E', '/service/my-app/weather/%2E%2E/admin'],
    ['%2e.', '/service/my-app/weather/%2e./admin'],
    ['.%2E', '/service/my-app/.%2E'],
    ['%2e', '/service/my-app/%2e/admin'],
    ['a dot-dot behind an encoded slash', '/service/my-app/weather/a%2F..%2Fadmin'],
    ['a dot-dot before an encoded slash', '/service/my-app/..%2fadmin'],
    ['a dot-dot behind an encoded backslash', '/service/my-app/x%5C..%5Cadmin'],
    ['a dot-dot as the service ID', '/service/../admin'],
  ])('refuses %s with invalid_path, before anything is matched', (_case, target) => {
    expect(() => parseServicePath(target)).toThrow(InvalidPathError);
  });

  it.each([
    ['three dots', '/service/my-app/...'],
    ['a dotted name', '/service/my-app/v1.2/.hidden'],
    ['an encoded dot-dot behind %25, which an upstream decodes once to %2E%2E', '/service/my-app/%252E%252E'],
  ])('takes %s', (_case, target) => {
    expect(() => parseServicePath(target)).not.toThrow();
  });
});
