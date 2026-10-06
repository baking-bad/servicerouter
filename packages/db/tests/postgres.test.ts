import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger, Secret } from '@servicerouter/common';

import { createPostgres, defaultConnectTimeoutMs } from '../src/index.js';

const logger = createLogger({ level: 'silent' });
let server: Server | undefined;
const sockets = new Set<Socket>();

// Accepts TCP connections and never answers, like a server that hangs during the handshake
const startSilentServer = async (): Promise<number> => {
  server = createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => undefined);
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));

  return (server.address() as AddressInfo).port;
};

afterEach(async () => {
  for (const socket of sockets)
    socket.destroy();
  sockets.clear();
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
  server = undefined;
});

describe('createPostgres (backlog D-7)', () => {
  it('fails a ping once the connect timeout passes, while the server accepts but never answers', async () => {
    const port = await startSilentServer();
    const postgres = createPostgres({ url: Secret.from(`postgres://nobody:secret@127.0.0.1:${port}/none`), logger, connectTimeoutMs: 200 });
    const started = Date.now();

    await expect(postgres.ping()).rejects.toThrow(/timeout/i);
    expect(Date.now() - started).toBeLessThan(2_000);
    await postgres.close();
  });

  it('times out new connections after 5 s by default', async () => {
    const pool = vi.spyOn(pg, 'Pool');
    const postgres = createPostgres({ url: Secret.from('postgres://nobody:secret@127.0.0.1:1/none'), logger });

    expect(defaultConnectTimeoutMs).toBe(5_000);
    expect(pool).toHaveBeenCalledWith(expect.objectContaining({ connectionTimeoutMillis: 5_000 }));
    pool.mockRestore();
    await postgres.close();
  });
});
