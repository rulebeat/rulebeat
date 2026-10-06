import { afterEach, describe, expect, it } from 'vitest';
import {
  PasswordGateBusyError, isPasswordGateSaturated, resetPasswordGateForTests,
  setPasswordGateLimitsForTests, withPasswordGate,
} from '@/lib/password';

afterEach(() => {
  resetPasswordGateForTests();
});

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('withPasswordGate concurrency', () => {
  it('never runs more jobs at once than the configured concurrency limit', async () => {
    setPasswordGateLimitsForTests(2, 20);
    let active = 0;
    let maxActive = 0;

    const job = () => withPasswordGate(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(10);
      active--;
    });

    await Promise.all(Array.from({ length: 8 }, job));

    expect(maxActive).toBeLessThanOrEqual(2);
    // Not just "never exceeded" — the limit must actually have been hit, or this would pass
    // vacuously if the gate did nothing at all.
    expect(maxActive).toBe(2);
    expect(active).toBe(0);
  });

  it('never rejects a wait-in-line (non-failFast) caller, even past the queue cap', async () => {
    // 1 concurrent + 1 queued = 2 total capacity; 5 callers is well past that, yet none of them
    // has opted into failFast, so every one of them must eventually run rather than reject.
    setPasswordGateLimitsForTests(1, 1);

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => withPasswordGate(async () => {
        await sleep(1);
        return i;
      })),
    );

    expect(results).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('withPasswordGate fail-fast behaviour', () => {
  it('rejects immediately, without running the job, once every slot and the queue are full', async () => {
    setPasswordGateLimitsForTests(1, 2);

    const releases: Array<() => void> = [];
    const block = () => new Promise<void>((resolve) => { releases.push(resolve); });

    // One caller takes the only running slot; two more fill the queue. None of these pass
    // failFast, so they just wait — this is only to saturate the gate for the next assertion.
    const occupied = [0, 1, 2].map(() => withPasswordGate(block));
    await Promise.resolve(); // let the synchronous acquire/enqueue logic run

    expect(isPasswordGateSaturated()).toBe(true);

    let ran = false;
    await expect(
      withPasswordGate(async () => { ran = true; }, { failFast: true }),
    ).rejects.toBeInstanceOf(PasswordGateBusyError);
    expect(ran).toBe(false);

    // Drain one at a time: releasing the running job frees a slot, which lets the next *queued*
    // job start and call `block()` for the first time, pushing its own resolver — snapshotting
    // `releases` up front would miss those later-created ones.
    while (releases.length > 0) {
      releases.shift()!();
      await sleep(0);
    }
    await Promise.all(occupied);
  });

  it('a fail-fast caller still runs normally while the gate has room', async () => {
    setPasswordGateLimitsForTests(2, 20);
    const result = await withPasswordGate(async () => 'ok', { failFast: true });
    expect(result).toBe('ok');
  });

  it('isPasswordGateSaturated reflects the running+queued state exactly', async () => {
    setPasswordGateLimitsForTests(1, 0);
    expect(isPasswordGateSaturated()).toBe(false);

    const releases: Array<() => void> = [];
    const block = () => new Promise<void>((resolve) => { releases.push(resolve); });
    const occupied = withPasswordGate(block);
    await Promise.resolve();

    expect(isPasswordGateSaturated()).toBe(true);
    releases.forEach(release => release());
    await occupied;

    expect(isPasswordGateSaturated()).toBe(false);
  });
});
