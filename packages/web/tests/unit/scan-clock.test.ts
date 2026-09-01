/**
 * WS2g · the injectable clock the demo generator's chronological replay depends on.
 *
 * `RunScanOptions.now` (lib/scan-runner.ts), `StartRunOptions.now`/`finishRun`'s `patch.now`
 * (lib/schedule-runs.ts) and `executeTarget`'s `opts.now` (lib/run-executor.ts) all default to the
 * real clock so nothing changes for a live scan, but the demo generator needs a forward,
 * chronological replay to land on the *simulated* day at every layer — the scan summary's own
 * timestamps, the schedule_runs row, `finding_events.occurred_at`, and the daily snapshot's date
 * key. This suite proves the override actually reaches every one of those, rather than trusting the
 * doc comments describing it.
 *
 * It also stands as the regression test for the correctness fix called out in
 * `lib/db/findings.ts`: `finding_events.occurred_at` must be stamped from the scan's own
 * `finishedAt`, not `new Date()` — an event records when the scan *observed* the transition, and a
 * backdated replay needs that to be the simulated day, not the instant the generator happened to
 * run.
 *
 * The identity category is used throughout rather than a rule-engine category, because its rules
 * run through `runGraphRules()`, which never touches `queryARG` — only `graphGet` — which keeps
 * every test here about the clock, not about getting a fake KQL match right.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { one as execOne, many as execMany } from '@/lib/db/exec';
import { findingEvents } from '@/lib/db/tables';
import { getCategory } from '@/lib/db/categories';
import { runCategoryScan } from '@/lib/scan-runner';
import { getSnapshots } from '@/lib/db/snapshots';
import { executeTarget } from '@/lib/run-executor';
import { resetDb } from '../helpers/db';
import { fakeTenantContext } from '../helpers/fake-azure';

const SIMULATED_DAY_1 = new Date('2026-05-01T09:00:00.000Z');
const SIMULATED_DAY_2 = new Date('2026-05-02T09:00:00.000Z');

async function identityCategory() {
  const category = await getCategory('identity');
  expect(category, "expected the seeded 'identity' category to exist").toBeTruthy();
  return category!;
}

/** A Graph app with one secret expiring in `days` days, on a distinct keyId so its fingerprint
 *  never collides with another test's finding. */
function expiringAppFixture(days: number, keyId: string) {
  return {
    graphRows: [{
      id: `app-${keyId}`,
      displayName: 'Contoso Sync Service',
      appId: '11111111-0000-0000-0000-000000000000',
      passwordCredentials: [{ displayName: 'sync-secret', endDateTime: new Date(Date.now() + days * 86_400_000).toISOString(), keyId }],
      keyCredentials: [],
    }],
  };
}

beforeEach(async () => {
  await resetDb();
});

describe('await runCategoryScan() respects an injected now', () => {
  it('stamps the scan summary startedAt/finishedAt from opts.now, not the real clock', async () => {
    const ctx = fakeTenantContext(expiringAppFixture(10, 'k1'));
    const { summary } = await runCategoryScan(await identityCategory(), { now: SIMULATED_DAY_1, ctx });

    expect(summary.startedAt).toBe(SIMULATED_DAY_1.toISOString());
    expect(summary.finishedAt).toBe(SIMULATED_DAY_1.toISOString());
    expect(summary.durationMs).toBe(0);
  });

  it('defaults to the real clock when no now is passed', async () => {
    const before = Date.now();
    const ctx = fakeTenantContext(expiringAppFixture(10, 'k2'));
    const { summary } = await runCategoryScan(await identityCategory(), { ctx });
    const after = Date.now();

    const started = new Date(summary.startedAt).getTime();
    expect(started).toBeGreaterThanOrEqual(before);
    expect(started).toBeLessThanOrEqual(after);
  });

  it('stamps finding_events.occurred_at from opts.now — the correctness fix', async () => {
    const ctx = fakeTenantContext(expiringAppFixture(10, 'k3'));
    const { newFindings } = await runCategoryScan(await identityCategory(), { now: SIMULATED_DAY_1, ctx });

    expect(newFindings).toHaveLength(1);
    const event = await execOne(db.select().from(findingEvents).where(eq(findingEvents.fingerprint, newFindings[0]!.fingerprint)));

    expect(event).toBeTruthy();
    expect(event!.type).toBe('created');
    expect(event!.occurredAt).toBe(SIMULATED_DAY_1.toISOString());
  });

  it('stamps a resolved event from the resolving scan\'s own now, not the creating scan\'s', async () => {
    const createCtx = fakeTenantContext(expiringAppFixture(10, 'k4'));
    const { newFindings } = await runCategoryScan(await identityCategory(), { now: SIMULATED_DAY_1, ctx: createCtx });
    const fingerprint = newFindings[0]!.fingerprint;

    // Day 2: the same app, no more expiring credentials — the finding resolves.
    const resolveCtx = fakeTenantContext({ graphRows: [] });
    await runCategoryScan(await identityCategory(), { now: SIMULATED_DAY_2, ctx: resolveCtx });

    const event = (await execMany(db.select().from(findingEvents)
      .where(eq(findingEvents.fingerprint, fingerprint))))
      .find(e => e.type === 'resolved');

    expect(event).toBeTruthy();
    expect(event!.occurredAt).toBe(SIMULATED_DAY_2.toISOString());
  });

  it('passes opts.now through to the daily snapshot it writes', async () => {
    const ctx = fakeTenantContext(expiringAppFixture(10, 'k5'));
    await runCategoryScan(await identityCategory(), { now: SIMULATED_DAY_1, ctx });

    const snapshots = await getSnapshots({ categories: ['identity'] });
    const dateKey = SIMULATED_DAY_1.toISOString().slice(0, 10);
    expect(snapshots.some(s => s.date === dateKey)).toBe(true);
  });
});

describe('await executeTarget() threads opts.now and opts.ctx end to end', () => {
  it('stamps the schedule_runs row from opts.now, not the real clock', async () => {
    const ctx = fakeTenantContext(expiringAppFixture(10, 'k6'));
    const run = await executeTarget(
      { targetType: 'categories', targetValues: ['identity'] },
      { triggeredBy: 'manual', ctx, now: SIMULATED_DAY_1 },
    );

    expect(run.status).toBe('success');
    expect(run.startedAt).toBe(SIMULATED_DAY_1.toISOString());
    expect(run.finishedAt).toBe(SIMULATED_DAY_1.toISOString());
  });

  it('runs entirely against the injected ctx, never a real Azure call', async () => {
    const ctx = fakeTenantContext(expiringAppFixture(10, 'k7'));
    await executeTarget(
      { targetType: 'categories', targetValues: ['identity'] },
      { triggeredBy: 'manual', ctx, now: SIMULATED_DAY_1 },
    );

    expect(ctx.queries).toEqual([]); // identity never issues ARG queries
    expect(ctx.graphRequests.length).toBeGreaterThan(0);
  });
});
