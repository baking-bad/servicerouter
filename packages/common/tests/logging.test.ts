import { describe, expect, it } from 'vitest';

import { createLogger, redactedHeaders, redactedMessage } from '../src/index.js';

const capture = () => {
  const lines: Record<string, unknown>[] = [];

  return {
    lines,
    stream: { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
  };
};

describe('createLogger (CK-3)', () => {
  it('redacts credential and payment headers on requests and responses', () => {
    const { lines, stream } = capture();
    const headers = Object.fromEntries(redactedHeaders.map(header => [header, 'do-not-log']));
    createLogger({}, stream).info({ req: { headers: { ...headers, accept: 'application/json' } }, res: { headers } }, 'request');

    const [line] = lines;
    expect(JSON.stringify(line)).not.toContain('do-not-log');
    expect(line).toMatchObject({
      req: { headers: { authorization: redactedMessage, cookie: redactedMessage, accept: 'application/json' } },
      res: { headers: { 'set-cookie': redactedMessage, 'payment-response': redactedMessage } },
    });
  });

  it('serializes errors without dropping their message', () => {
    const { lines, stream } = capture();
    createLogger({}, stream).error({ error: new Error('boom') }, 'failed');

    expect(lines[0]).toMatchObject({ error: { message: 'boom', type: 'Error' } });
  });
});
