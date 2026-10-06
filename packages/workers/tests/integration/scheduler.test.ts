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

describe('the scheduler\'s lines (L-8)', () => {
  const captured = () => {
    const lines: Record<string, unknown>[] = [];
    const capturing = createLogger({ level: 'debug' }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });

    return { lines, capturing };
  };
  const schedulerWith = (run: Job['run'], capturing: ReturnType<typeof createLogger>, locks: Pick<Postgres, 'tryAdvisoryLock'> = database.postgres) => {
    lockId += 1;
    const job: Job = { name: 'logged_job', lockId, intervalMs: 60_000, run };

    return { job, scheduler: createScheduler({ jobs: [job], locks, clock: createFakeClock(fixtureTime(0, 5, 12, 0, 0, 0)), timers: createManualTimers(), logger: capturing, registry: new Registry() }) };
  };

  it('logs a run that did something at info, with the job, its counts, and the duration; a run that did nothing at debug', async () => {
    const { lines, capturing } = captured();
    let acted = true;
    const { scheduler } = schedulerWith(async () => ({ counts: { captured: acted ? 2 : 0, released: 0 }, acted }), capturing);

    await scheduler.runNow('logged_job');
    acted = false;
    await scheduler.runNow('logged_job');

    expect(lines.filter(line => line['msg'] === 'A job ran')).toEqual([
      expect.objectContaining({ level: 30, job: 'logged_job', counts: { captured: 2, released: 0 }, durationMs: expect.any(Number) }),
      expect.objectContaining({ level: 20, job: 'logged_job', counts: { captured: 0, released: 0 } }),
    ]);
  });

  it('logs a failed run at error, with the cause chain and the counts it reached', async () => {
    const { lines, capturing } = captured();
    const { scheduler } = schedulerWith(async () => {
      throw Object.assign(new Error('2 expired holds couldn\'t be finished', { cause: Object.assign(new Error('deadlock detected'), { code: '40P01' }) }), {
        result: { captured: 1, released: 0, failed: 2 },
      });
    }, capturing);

    expect(await scheduler.runNow('logged_job')).toBe('failure');

    expect(lines.filter(line => line['msg'] === 'A job failed')).toEqual([expect.objectContaining({
      level: 50, job: 'logged_job', counts: { captured: 1, released: 0, failed: 2 }, durationMs: expect.any(Number),
      error: expect.objectContaining({ message: '2 expired holds couldn\'t be finished: deadlock detected', cause: expect.objectContaining({ code: '40P01' }), stack: expect.any(String) }),
    })]);
  });

  it('logs a run skipped for another replica\'s lock at debug', async () => {
    const { lines, capturing } = captured();
    const gate = deferred();
    const started = deferred();
    const first = schedulerWith(async () => {
      started.resolve();
      await gate.promise;
    }, capturing);
    const second = createScheduler({
      jobs: [first.job], locks: replica, clock: createFakeClock(fixtureTime(0, 5, 12, 0, 0, 0)), timers: createManualTimers(), logger: capturing, registry: new Registry(),
    });

    const running = first.scheduler.runNow('logged_job');
    await started.promise;
    const skipped = await second.runNow('logged_job');
    gate.resolve();
    await running;

    expect(skipped).toBe('skipped');

    expect(lines.find(line => line['msg'] === 'A job run was skipped: another replica holds its lock')).toMatchObject({ level: 20, job: 'logged_job' });
  });
});
