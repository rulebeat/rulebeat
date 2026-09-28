/**
 * The two ways a running Demo gets Reset: the timer on wall-clock boundaries, and
 * `rulebeat-demo reset` run inside the container, which reaches the server through a request file
 * and a signal (there is no HTTP way to start a Reset, since every Visitor is an admin).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEMO_PID_FILE,
  DEMO_RESET_REQUEST_FILE,
  DEMO_RESET_RESULT_FILE,
  answerDemoResetRequest,
  nextDemoResetAt,
} from '@/lib/demo/live-reset';
import * as cli from '../../bin/rulebeat-demo.mjs';

describe('nextDemoResetAt()', () => {
  it('lands on the top of the next hour with the default 60 minutes', () => {
    expect(nextDemoResetAt(new Date(2026, 0, 10, 14, 20, 5), 60)).toEqual(new Date(2026, 0, 10, 15, 0, 0));
  });

  it('moves to the following boundary when now is exactly on one', () => {
    expect(nextDemoResetAt(new Date(2026, 0, 10, 15, 0, 0), 60)).toEqual(new Date(2026, 0, 10, 16, 0, 0));
  });

  it('counts shorter intervals from midnight', () => {
    expect(nextDemoResetAt(new Date(2026, 0, 10, 14, 20), 30)).toEqual(new Date(2026, 0, 10, 14, 30));
    expect(nextDemoResetAt(new Date(2026, 0, 10, 14, 50), 15)).toEqual(new Date(2026, 0, 10, 15, 0));
  });

  it('restarts an interval that does not divide the day at the next midnight', () => {
    // 7 hours: 00:00, 07:00, 14:00, 21:00, then midnight rather than 04:00.
    expect(nextDemoResetAt(new Date(2026, 0, 10, 22, 0), 420)).toEqual(new Date(2026, 0, 11, 0, 0));
  });
});

describe('rulebeat-demo reset', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rulebeat-demo-cli-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('shares its file names with the server', () => {
    expect([cli.PID_FILE, cli.REQUEST_FILE, cli.RESULT_FILE])
      .toEqual([DEMO_PID_FILE, DEMO_RESET_REQUEST_FILE, DEMO_RESET_RESULT_FILE]);
  });

  it('asks the server for a Reset and reports its answer', async () => {
    writeFileSync(join(dir, DEMO_PID_FILE), '4242');
    const resetAt = new Date('2026-03-01T12:00:00.000Z');
    let signalled: number | undefined;

    const result = await cli.requestReset({
      dataDir: dir,
      pollMs: 5,
      // Stands in for SIGUSR2 reaching the server: the server answers the request it finds.
      signal: (pid: number) => {
        signalled = pid;
        void answerDemoResetRequest(dir, async () => resetAt);
      },
    });

    expect(signalled).toBe(4242);
    expect(result).toMatchObject({ ok: true, resetAt: resetAt.toISOString() });
    expect(existsSync(join(dir, DEMO_RESET_REQUEST_FILE))).toBe(false);
  });

  it('passes on the reason a Reset failed', async () => {
    writeFileSync(join(dir, DEMO_PID_FILE), '4242');
    const result = await cli.requestReset({
      dataDir: dir,
      pollMs: 5,
      signal: () => void answerDemoResetRequest(dir, async () => { throw new Error('not a Demo database'); }),
    });
    expect(result).toMatchObject({ ok: false, error: 'not a Demo database' });
  });

  it('ignores an answer left over from an earlier request and times out', async () => {
    writeFileSync(join(dir, DEMO_PID_FILE), '4242');
    await expect(cli.requestReset({
      dataDir: dir,
      pollMs: 5,
      timeoutMs: 50,
      signal: () => writeFileSync(join(dir, DEMO_RESET_RESULT_FILE), JSON.stringify({ id: 'earlier', ok: true })),
    })).rejects.toThrow(/did not answer/);
  });

  it('says so when the server cannot be signalled, and withdraws the request', async () => {
    writeFileSync(join(dir, DEMO_PID_FILE), '4242');
    await expect(cli.requestReset({
      dataDir: dir,
      signal: () => { throw new Error('ESRCH'); },
    })).rejects.toThrow(/Could not reach the RuleBeat server \(pid 4242\)/);
    expect(existsSync(join(dir, DEMO_RESET_REQUEST_FILE))).toBe(false);
  });

  it('finds the data directory by the server pid file', () => {
    expect(cli.findDataDir(dir)).toBeNull();
    const data = join(dir, 'data');
    rmSync(data, { recursive: true, force: true });
    mkdirSync(data);
    writeFileSync(join(data, DEMO_PID_FILE), '1');
    expect(cli.findDataDir(dir)).toBe(data);
  });
});

describe('answerDemoResetRequest()', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rulebeat-demo-answer-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('does nothing without a request, so a stray signal cannot Reset the Demo', async () => {
    let resets = 0;
    await answerDemoResetRequest(dir, async () => { resets += 1; return new Date(); });
    expect(resets).toBe(0);
    expect(existsSync(join(dir, DEMO_RESET_RESULT_FILE))).toBe(false);
  });

  it('answers under the id it was asked with', async () => {
    writeFileSync(join(dir, DEMO_RESET_REQUEST_FILE), JSON.stringify({ id: 'abc' }));
    await answerDemoResetRequest(dir, async () => new Date('2026-03-01T12:00:00.000Z'));
    expect(JSON.parse(readFileSync(join(dir, DEMO_RESET_RESULT_FILE), 'utf8')))
      .toEqual({ id: 'abc', ok: true, resetAt: '2026-03-01T12:00:00.000Z' });
  });
});
