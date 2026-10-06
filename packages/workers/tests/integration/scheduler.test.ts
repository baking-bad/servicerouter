import { fixtureTime } from '@servicerouter/testing';

import { Registry } from '@prometheus-io/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLogger } from '@servicerouter/common';
import { createPostgres, type Postgres } from '@servicerouter/db';
import { createFakeClock, createManualTimers, createTestDatabase, type TestDatabase } from '@servicerouter/testing';

import { createScheduler, type Job } from '../../src/scheduler.js';

const logger = createLogger({ level: 'silent' });

let database: TestDatabase;
// A second replica: its own pool, so its own sessions
let replica: Postgres;
let lockId = 9_100;

beforeAll(async () => {
  database = await createTestDatabase();
  replica = createPostgres({ url: database.url, logger });
});

afterAll(async () => {
  await replica?.close();
  await database?.drop();
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(onResolve => {
    resolve = onResolve;
  });

  return { promise, resolve };
};

const setup = (run: () => Promise<void>, locks: Pick<Postgres, 'tryAdvisoryLock'> = database.postgres) => {
  lockId += 1;
  const registry = new Registry();
  const clock = createFakeClock(fixtureTime(0, 5, 12, 0, 0, 0));
  const timers = createManualTimers();
  const job: Job = { name: 'test_job', lockId, intervalMs: 60_000, run };
  const scheduler = createScheduler({ jobs: [job], locks, clock, timers, logger, registry });

  return { scheduler, registry, clock, timers, job };
};

const metric = async (registry: Registry, series: string): Promise<number | undefined> => {
  const line = (await registry.metrics()).split('\n').find(text => text.startsWith(`${series} `));

  return line === undefined ? undefined : Number(line.slice(series.length + 1));
};

describe('the job scheduler (WK-1 to WK-4)', () => {
  it('runs a job on one replica at a time: the other finds the lock taken and skips (WK-1)', async () => {
    const gate = deferred();
    let runs = 0;
    const run = async () => {
      runs += 1;
      await gate.promise;
    };
    const first = setup(run);
    const second = createScheduler({ jobs: [first.job], locks: replica, clock: first.clock, timers: first.timers, logger, registry: new Registry() });

    const running = first.scheduler.runNow('test_job');
    await vi.waitFor(() => expect(runs).toBe(1));
    const skipped = await second.runNow('test_job');
    gate.resolve();

    expect(skipped).toBe('skipped');
    expect(await running).toBe('success');
    expect(runs).toBe(1);
    // Free again once the first run ended
    expect(await second.runNow('test_job')).toBe('success');
  });

  it('exports the last success time from the Clock, the last run\'s duration, and runs by result (WK-3, WK-4)', async () => {
    let fail = false;
    const { scheduler, registry, clock } = setup(async () => {
      if (fail)
        throw new Error('boom');
    });

    await scheduler.runNow('test_job');
    clock.advance(60_000);
    fail = true;
    expect(await scheduler.runNow('test_job')).toBe('failure');

    // A failed run leaves the last success where it was, so the job goes stale
    expect(await metric(registry, 'workers_job_last_success_timestamp_seconds{job="test_job"}')).toBe(Date.parse(fixtureTime(0, 5, 12, 0, 0, 0)) / 1_000);
    expect(await metric(registry, 'workers_job_duration_seconds{job="test_job"}')).toBeGreaterThanOrEqual(0);
    expect(await metric(registry, 'workers_job_runs_total{job="test_job",result="success"}')).toBe(1);
    expect(await metric(registry, 'workers_job_runs_total{job="test_job",result="failure"}')).toBe(1);
  });

  it('runs every interval once started, never two runs of a job at once, and stops waiting for the run in progress', async () => {
    let runs = 0;
    let gate = deferred();
    const { scheduler, timers } = setup(async () => {
      runs += 1;
      await gate.promise;
    });

    scheduler.start();
    timers.advance(59_999);
    expect(runs).toBe(0);
    timers.advance(1);
    await vi.waitFor(() => expect(runs).toBe(1));
    // The next run is scheduled only after this one ends
    timers.advance(120_000);
    expect(runs).toBe(1);
    gate.resolve();
    await vi.waitFor(() => expect(timers.pending).toBe(1));
    gate = deferred();
    timers.advance(60_000);
    await vi.waitFor(() => expect(runs).toBe(2));

    let stopped = false;
    const stopping = (async () => {
      await scheduler.stop();
      stopped = true;
    })();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    gate.resolve();
    await stopping;
    timers.advance(600_000);

    expect(timers.pending).toBe(0);
    expect(runs).toBe(2);
  });
});
