import { describe, expect, it, vi } from 'vitest';

import { Secret } from '@servicerouter/common';

import { parseSubmitBody } from '../../src/services/body.js';

const json = (value: unknown) => Buffer.from(JSON.stringify(value));

const thrown = (parse: () => unknown): Error => {
  try {
    parse();
  }
  catch (error) {
    return error as Error;
  }
  throw new Error('Expected an error');
};

describe('parseSubmitBody (SR-12, SC-9)', () => {
  it('takes YAML text as the config, for each YAML media type', () => {
    for (const contentType of ['application/yaml', 'application/x-yaml', 'text/yaml; charset=utf-8']) {
      const body = parseSubmitBody(Buffer.from('servicerouter:\n  version: "1"\n'), contentType);

      expect(body).toMatchObject({ source: 'servicerouter:\n  version: "1"\n', submitted: { mediaType: 'application/yaml' } });
      expect(body.secrets.size).toBe(0);
    }
  });

  it('takes JSON without a top-level config as the config, as text so issues get positions', () => {
    const text = '{\n  "servicerouter": { "version": "1" }\n}';

    expect(parseSubmitBody(Buffer.from(text), 'application/json')).toMatchObject({ source: text, submitted: { mediaType: 'application/json', text } });
  });

  it('takes the secrets out of an envelope first, each value in a Secret, and null as a delete', () => {
    const body = parseSubmitBody(json({ config: 'service: {}', secrets: { 'weather-key': 'sk-live-1', 'old-key': null } }), 'application/json');

    expect(body.source).toBe('service: {}');
    expect(body.secrets.get('weather-key')).toBeInstanceOf(Secret);
    expect(body.secrets.get('weather-key')?.expose()).toBe('sk-live-1');
    expect(body.secrets.get('old-key')).toBeNull();
    expect(JSON.stringify(body)).not.toContain('sk-live-1');
  });

  it('keeps a config object from an envelope as JSON text, and locates its issues in the envelope', () => {
    const text = '{\n  "config": {\n    "service": {\n      "category": "sports"\n    }\n  },\n  "secrets": { "weather-key": "sk-live-1" }\n}';
    const body = parseSubmitBody(Buffer.from(text), 'application/json');

    expect(body.source).toEqual({ service: { category: 'sports' } });
    expect(body.submitted).toEqual({ mediaType: 'application/json', text: JSON.stringify({ service: { category: 'sports' } }, null, 2) });
    expect(body.locate([{ path: '/service/category', message: 'is not a platform category' }])).toEqual([
      { path: '/service/category', message: 'is not a platform category', line: 4, column: 19 },
    ]);
  });

  it('destroys the secrets it made when a later one is refused', () => {
    const destroy = vi.spyOn(Secret.prototype, 'destroy');

    const error = thrown(() => parseSubmitBody(json({ config: 'x', secrets: { first: 'sk-live-1', second: 42 } }), 'application/json'));

    expect(error).toMatchObject({ code: 'invalid_request', message: 'The secret "second" must be a string, or null to delete it' });
    expect(destroy).toHaveBeenCalledTimes(1);
    destroy.mockRestore();
  });

  it('sends YAML that isn\'t UTF-8 to pass 1 as bytes, which reports it', () => {
    const bytes = Buffer.from([0x61, 0x3a, 0x20, 0xff]);

    expect(parseSubmitBody(bytes, 'application/yaml').source).toBe(bytes);
  });

  it.each([
    ['no body', undefined],
    ['an empty body', Buffer.alloc(0)],
  ])('refuses %s with invalid_request', (_case, body) => {
    expect(thrown(() => parseSubmitBody(body, 'application/yaml'))).toMatchObject({ code: 'invalid_request' });
  });
});
