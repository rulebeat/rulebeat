/**
 * Issue #193 (ADR 0006): a finding that gains a Row it did not have counts as changed; a Row that
 * goes away, or whose values change, is recorded in the finding's history. Driven through the
 * highest seam: runCategoryScan() over the fake Azure context, two scans in a row, then reading the
 * finding's events back.
 *
 * Rows are compared on every column, so a moved retirement date is one row removed and one added.
 * A created or reactivated finding is not changed (it is already new). A capped, failed or invalid
 * outcome records no row events at all, and does not overwrite the rows the next successful scan
 * will be compared against.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { computeActivityFingerprint, computeFingerprint } from '@rulebeat/core';
import { db } from '@/lib/db/client';
import { run as execRun, many as execMany } from '@/lib/db/exec';
import { findingEvents as findingEventsTable, findings as findingsTable, rules as rulesTable } from '@/lib/db/tables';
import { getCategory } from '@/lib/db/categories';
import { getActivityOccurrenceCounts, getFindingEventCounts, listFindings } from '@/lib/db/findings';
import { runCategoryScan } from '@/lib/scan-runner';
import { resetDb } from '../helpers/db';
import { fakeTenantContext, argRow } from '../helpers/fake-azure';

const ARG_RULE = 'test-changes-arg-rule';
const LOGS_RULE = 'test-changes-logs-rule';
const ARG_KQL = 'resources | where type == "microsoft.compute/virtualmachines"';

const VM_ONE = argRow({ name: 'vm-one' });
const VM_ONE_ID = String(VM_ONE.id);
const FINGERPRINT = computeFingerprint(ARG_RULE, VM_ONE_ID);

const baseRule = {
  description: 'test rule',
  category: 'identity',
  severity: 'medium',
  enabled: true,
  scope: JSON.stringify({ level: 'subscription' }),
  resourceTypes: JSON.stringify([]),
  conditions: JSON.stringify([]),
  type: 'custom',
};

async function insertRule(id: string, extra: Record<string, unknown>): Promise<void> {
  await execRun(db.delete(rulesTable).where(eq(rulesTable.id, id)));
  await execRun(db.insert(rulesTable).values({ ...baseRule, id, name: id, ...extra }));
}

const insertArgRule = (kql = ARG_KQL) => insertRule(ARG_RULE, { rawKql: kql });

async function scan(ctxOptions: Parameters<typeof fakeTenantContext>[0], hoursFromBase = 0, ruleId = ARG_RULE) {
  const category = (await getCategory('identity'))!;
  return runCategoryScan(category, {
    ctx: fakeTenantContext(ctxOptions),
    ruleIds: [ruleId],
    now: new Date(Date.UTC(2026, 5, 1, hoursFromBase)),
  });
}

const vmRows = (...retirements: string[]) => retirements.map(retirement => ({ ...VM_ONE, retirement }));

async function rowEvents(fingerprint = FINGERPRINT) {
  const events = await execMany(db.select().from(findingEventsTable).where(eq(findingEventsTable.fingerprint, fingerprint)));
  return events
    .filter(e => e.type === 'row_added' || e.type === 'row_removed')
    .map(e => ({ type: e.type, row: JSON.parse(e.rowPayload!) as Record<string, unknown>, occurredAt: e.occurredAt }))
    .sort((a, b) => a.type.localeCompare(b.type));
}

async function eventTypes(fingerprint = FINGERPRINT) {
  return (await execMany(db.select().from(findingEventsTable).where(eq(findingEventsTable.fingerprint, fingerprint)))).map(e => e.type).sort();
}

const storedRows = async (fingerprint = FINGERPRINT) => (await listFindings()).find(f => f.fingerprint === fingerprint)!.rows;

beforeEach(async () => {
  await resetDb();
  await insertArgRule();
});

describe('a finding that gains a row', () => {
  it('is changed, lists the added row, and records one row added event', async () => {
    await scan({ rows: vmRows('Basic tier') }, 0);
    const second = await scan({ rows: vmRows('Basic tier', 'TLS 1.0') }, 24);

    expect(second.changedFindings.map(f => ({ fingerprint: f.fingerprint, addedRows: f.addedRows }))).toEqual([
      { fingerprint: FINGERPRINT, addedRows: [{ retirement: 'TLS 1.0' }] },
    ]);
    expect(second.changedFindings[0]!.resourceName).toBe('vm-one');
    expect(second.newFindings).toEqual([]);
    expect(await rowEvents()).toEqual([
      { type: 'row_added', row: { retirement: 'TLS 1.0' }, occurredAt: '2026-06-02T00:00:00.000Z' },
    ]);
  });

  it('keeps its age and counts one more sighting', async () => {
    await scan({ rows: vmRows('a') }, 0);
    await scan({ rows: vmRows('a', 'b') }, 24);
    const found = (await listFindings())[0]!;
    expect(found.firstSeenAt).toBe('2026-06-01T00:00:00.000Z');
    expect(found.timesSeen).toBe(2);
    expect(found.rows.map(r => r.retirement)).toEqual(['a', 'b']);
  });

  it('is not changed by a scan that returns the same rows again, even in another order', async () => {
    await scan({ rows: vmRows('a', 'b') }, 0);
    const second = await scan({ rows: vmRows('b', 'a') }, 24);

    expect(second.changedFindings).toEqual([]);
    expect(await rowEvents()).toEqual([]);
  });

  it('lists every added row when it gains several', async () => {
    await scan({ rows: vmRows('a') }, 0);
    const second = await scan({ rows: vmRows('a', 'b', 'c') }, 24);

    expect(second.changedFindings[0]!.addedRows).toEqual([{ retirement: 'b' }, { retirement: 'c' }]);
    expect((await rowEvents()).map(e => e.type)).toEqual(['row_added', 'row_added']);
  });

  it('compares a finding stored before rows existed against the one row made from its evidence', async () => {
    await scan({ rows: vmRows('old') }, 0);
    await execRun(db.update(findingsTable).set({ evidenceRows: null }).where(eq(findingsTable.fingerprint, FINGERPRINT)));

    const second = await scan({ rows: vmRows('old', 'new') }, 24);

    expect(second.changedFindings[0]!.addedRows).toEqual([{ retirement: 'new' }]);
    expect(await rowEvents()).toEqual([
      { type: 'row_added', row: { retirement: 'new' }, occurredAt: '2026-06-02T00:00:00.000Z' },
    ]);
  });
});

describe('a finding that loses a row', () => {
  it('records one row removed event and is not changed', async () => {
    await scan({ rows: vmRows('a', 'b') }, 0);
    const second = await scan({ rows: vmRows('a') }, 24);

    expect(second.changedFindings).toEqual([]);
    expect(await rowEvents()).toEqual([
      { type: 'row_removed', row: { retirement: 'b' }, occurredAt: '2026-06-02T00:00:00.000Z' },
    ]);
    expect(await storedRows()).toEqual([{ retirement: 'a' }]);
  });

  it('records a row whose value changed as one row removed and one row added, and is changed', async () => {
    await scan({ rows: [{ ...VM_ONE, retirement: 'Basic tier', retiresOn: '2026-09-30' }] }, 0);
    const second = await scan({ rows: [{ ...VM_ONE, retirement: 'Basic tier', retiresOn: '2026-12-31' }] }, 24);

    expect(await rowEvents()).toEqual([
      { type: 'row_added', row: { retirement: 'Basic tier', retiresOn: '2026-12-31' }, occurredAt: '2026-06-02T00:00:00.000Z' },
      { type: 'row_removed', row: { retirement: 'Basic tier', retiresOn: '2026-09-30' }, occurredAt: '2026-06-02T00:00:00.000Z' },
    ]);
    expect(second.changedFindings[0]!.addedRows).toEqual([{ retirement: 'Basic tier', retiresOn: '2026-12-31' }]);
  });
});

describe('a finding that is new or fixed', () => {
  it('records no row events when it is created with several rows', async () => {
    const first = await scan({ rows: vmRows('a', 'b') }, 0);

    expect(first.changedFindings).toEqual([]);
    expect(first.newFindings).toHaveLength(1);
    expect(await eventTypes()).toEqual(['created']);
  });

  it('records no row events when it reactivates, and counts as new rather than changed', async () => {
    await scan({ rows: vmRows('a') }, 0);
    await scan({ rows: [{ ...argRow({ name: 'vm-other' }) }] }, 24);
    const third = await scan({ rows: vmRows('a', 'b') }, 48);

    expect(third.changedFindings).toEqual([]);
    expect(third.newFindings.map(f => f.fingerprint)).toEqual([FINGERPRINT]);
    expect(await eventTypes()).toEqual(['created', 'reactivated', 'resolved']);
  });

  it('records no row events when its rule returns no rows for it, only resolved', async () => {
    await scan({ rows: vmRows('a', 'b') }, 0);
    await scan({ rows: [] }, 24);

    expect(await eventTypes()).toEqual(['created', 'resolved']);
  });
});

describe('an outcome that is not a success', () => {
  beforeEach(async () => {
    await scan({ rows: vmRows('a', 'b') }, 0);
  });

  it('records no row events and no change when the rule was capped, and keeps the last complete rows', async () => {
    await insertArgRule(`${ARG_KQL} | take 5`);
    const capped = await scan({ rows: vmRows('a', 'x') }, 24);

    expect(capped.summary.incompleteRules.map(r => r.status)).toEqual(['capped']);
    expect(capped.changedFindings).toEqual([]);
    expect(await rowEvents()).toEqual([]);
    expect(await storedRows()).toEqual([{ retirement: 'a' }, { retirement: 'b' }]);
  });

  it('compares the next successful scan with the last complete rows, not the capped ones', async () => {
    await insertArgRule(`${ARG_KQL} | take 5`);
    await scan({ rows: vmRows('a', 'x') }, 24);
    await insertArgRule();

    const next = await scan({ rows: vmRows('a', 'b', 'x') }, 48);

    expect(next.changedFindings[0]!.addedRows).toEqual([{ retirement: 'x' }]);
    expect(await rowEvents()).toEqual([
      { type: 'row_added', row: { retirement: 'x' }, occurredAt: '2026-06-03T00:00:00.000Z' },
    ]);
  });

  it('still refreshes the capped finding\'s sighting and does not resolve it', async () => {
    await insertArgRule(`${ARG_KQL} | take 5`);
    await scan({ rows: vmRows('a') }, 24);

    const found = (await listFindings())[0]!;
    expect(found.status).toBe('active');
    expect(found.timesSeen).toBe(2);
    expect(found.lastSeenAt).toBe('2026-06-02T00:00:00.000Z');
  });

  it('records no row events when the rule failed', async () => {
    const failed = await scan({ failWith: new Error('boom') }, 24);

    expect(failed.summary.incompleteRules.map(r => r.status)).toEqual(['failed']);
    expect(failed.changedFindings).toEqual([]);
    expect(await rowEvents()).toEqual([]);
    expect(await storedRows()).toHaveLength(2);
  });

  it('records no row events when the rule came back invalid', async () => {
    const invalid = await scan({ rows: [{ name: 'no-id', n: 9 }] }, 24);

    expect(invalid.summary.incompleteRules.map(r => r.status)).toEqual(['invalid']);
    expect(invalid.changedFindings).toEqual([]);
    expect(await rowEvents()).toEqual([]);
    expect(await storedRows()).toHaveLength(2);
  });
});

describe('the counts that read finding events', () => {
  const SINCE = '2026-01-01T00:00:00.000Z';

  const rowEventTypes = ['row_added', 'row_removed'];
  const dropRowEvents = () => execRun(db.delete(findingEventsTable).where(inArray(findingEventsTable.type, rowEventTypes)));

  it('return the same series whether or not row events are stored, whatever the window', async () => {
    await scan({ rows: vmRows('a', 'b') }, 0);
    await scan({ rows: vmRows('b', 'c') }, 24);
    await scan({ rows: vmRows('b', 'c', 'd') }, 48);
    await scan({ rows: [] }, 72);
    expect(await rowEvents()).toHaveLength(3);

    const windows = [SINCE, '2026-06-02T00:00:00.000Z', '2026-06-03T00:00:00.000Z', '2026-06-04T00:00:00.000Z'];
    const withRowEvents = await Promise.all(windows.map(sinceDate => getFindingEventCounts({ sinceDate })));
    await dropRowEvents();
    expect(await rowEvents()).toEqual([]);
    const withoutRowEvents = await Promise.all(windows.map(sinceDate => getFindingEventCounts({ sinceDate })));

    expect(withRowEvents).toEqual(withoutRowEvents);
    // The lifecycle counts themselves, so the comparison above is not two copies of one wrong answer.
    const total = (counts: typeof withRowEvents[number], key: 'created' | 'resolved') => counts.reduce((sum, d) => sum + d[key], 0);
    expect(total(withRowEvents[0]!, 'created')).toBe(1);
    expect(total(withRowEvents[0]!, 'resolved')).toBe(1);
    expect(withRowEvents[0]![0]).toEqual({ date: '2026-06-01', created: 1, resolved: 0 });
    // The window that starts on the resolve day holds only that day's count, not the earlier row events.
    expect(withRowEvents[3]![0]).toEqual({ date: '2026-06-04', created: 0, resolved: 1 });
  });

  it('return [] for a window that holds only row events', async () => {
    await scan({ rows: vmRows('a') }, 0);
    await scan({ rows: vmRows('a', 'b') }, 24);
    expect(await rowEvents()).toHaveLength(1);

    expect(await getFindingEventCounts({ sinceDate: '2026-06-02T00:00:00.000Z' })).toEqual([]);
  });

  it('leave the activity occurrence counts at one per sighting when an Activity finding gains a row', async () => {
    await insertRule(LOGS_RULE, {
      queryBackend: 'log-analytics',
      logsQuery: JSON.stringify({ kql: 'SigninLogs | where ResultType != 0', timeWindowDays: 30, dimensionKeyField: 'UserId' }),
    });
    await scan({ logsRows: [{ UserId: 'u1', ResultType: '50126' }] }, 0, LOGS_RULE);
    const second = await scan({ logsRows: [{ UserId: 'u1', ResultType: '50126' }, { UserId: 'u1', ResultType: '50057' }] }, 24, LOGS_RULE);

    const fingerprint = computeActivityFingerprint(LOGS_RULE, 'u1');
    expect(second.changedFindings.map(f => f.fingerprint)).toEqual([fingerprint]);
    expect(await eventTypes(fingerprint)).toEqual(['created', 'occurred', 'row_added']);
    const occurrences = await getActivityOccurrenceCounts({ sinceDate: SINCE });
    expect(occurrences.reduce((sum, d) => sum + d.count, 0)).toBe(2);
  });
});
