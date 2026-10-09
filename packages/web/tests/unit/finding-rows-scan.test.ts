/**
 * Issue #192 (ADR 0006): a finding keeps every Row its rule's query returned for its resource,
 * instead of the last one. Driven through the highest seam: runCategoryScan() over the fake Azure
 * context, then reading findings back through the repository.
 *
 * Covers the three engines (Resource Graph, Microsoft Graph, Logs keyed by dimension value), that
 * identity is untouched (one fingerprint, one age, one suppression), that the same resource under
 * two rules stays two findings, and that a finding is Fixed only when its rule succeeded and
 * returned no rows for it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { computeActivityFingerprint, computeFingerprint } from '@rulebeat/core';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { findings as findingsTable, rules as rulesTable } from '@/lib/db/tables';
import { getCategory } from '@/lib/db/categories';
import { listFindings } from '@/lib/db/findings';
import { runCategoryScan } from '@/lib/scan-runner';
import { queryActiveFindings, queryActiveFindingsWithRows } from '@/lib/dashboard-data';
import { saveSuppressions } from '@/lib/suppressions';
import type { WidgetFilters } from '@/lib/dashboard-filters';
import { resetDb } from '../helpers/db';
import { fakeTenantContext, argRow } from '../helpers/fake-azure';

const ARG_RULE = 'test-rows-arg-rule';
const OTHER_ARG_RULE = 'test-rows-other-arg-rule';
const GRAPH_RULE = 'test-rows-graph-rule';
const LOGS_RULE = 'test-rows-logs-rule';
const ARG_KQL = 'resources | where type == "microsoft.compute/virtualmachines"';
const FILTERS: WidgetFilters = { dateWindow: { mode: 'relative', days: 7 } };

const VM_ONE = argRow({ name: 'vm-one' });
const VM_TWO = argRow({ name: 'vm-two' });
const VM_ONE_ID = String(VM_ONE.id);

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

const insertArgRule = (id = ARG_RULE, kql = ARG_KQL) => insertRule(id, { rawKql: kql });
const insertGraphRule = () => insertRule(GRAPH_RULE, {
  queryBackend: 'microsoft-graph',
  graphQuery: JSON.stringify({ path: 'applications' }),
});
const insertLogsRule = () => insertRule(LOGS_RULE, {
  queryBackend: 'log-analytics',
  logsQuery: JSON.stringify({ kql: 'SigninLogs | where ResultType != 0', timeWindowDays: 30, dimensionKeyField: 'UserId' }),
});

async function scan(ruleIds: string[], ctxOptions: Parameters<typeof fakeTenantContext>[0], hoursFromBase = 0) {
  const category = (await getCategory('identity'))!;
  return runCategoryScan(category, {
    ctx: fakeTenantContext(ctxOptions),
    ruleIds,
    now: new Date(Date.UTC(2026, 5, 1, hoursFromBase)),
  });
}

const findingFor = async (fingerprint: string) => (await listFindings()).find(f => f.fingerprint === fingerprint);

beforeEach(async () => {
  await resetDb();
});

describe('Resource Graph rules', () => {
  beforeEach(async () => { await insertArgRule(); });

  it('stores one finding holding every row a rule returned for one resource, in query order', async () => {
    const first = { ...VM_ONE, retirement: 'Basic tier', retiresOn: '2026-09-30' };
    const second = { ...VM_ONE, retirement: 'TLS 1.0', retiresOn: '2026-11-01' };
    const third = { ...VM_ONE, retirement: 'Gen1 images', retiresOn: '2027-01-15' };
    const other = { ...VM_TWO, retirement: 'Basic tier', retiresOn: '2026-09-30' };
    await scan([ARG_RULE], { rows: [first, other, second, third] });

    const stored = await listFindings();
    expect(stored.map(f => f.resourceId).sort()).toEqual([VM_ONE_ID, String(VM_TWO.id)].sort());

    const vmOne = (await findingFor(computeFingerprint(ARG_RULE, VM_ONE_ID)))!;
    expect(vmOne.rows.map(r => r.retirement)).toEqual(['Basic tier', 'TLS 1.0', 'Gen1 images']);
    expect(vmOne.evidence.retirement).toBe('Basic tier');
    expect(vmOne.timesSeen).toBe(1);

    const vmTwo = (await findingFor(computeFingerprint(ARG_RULE, String(VM_TWO.id))))!;
    expect(vmTwo.rows).toHaveLength(1);
  });

  it('stores one row when the query returns the same row twice for a resource', async () => {
    const row = { ...VM_ONE, retirement: 'Basic tier', retiresOn: '2026-09-30' };
    const reordered = Object.fromEntries(Object.entries(row).reverse());
    const other = { ...VM_ONE, retirement: 'TLS 1.0', retiresOn: '2026-11-01' };
    const outcome = await scan([ARG_RULE], { rows: [row, other, reordered, row] });

    const vmOne = (await findingFor(computeFingerprint(ARG_RULE, VM_ONE_ID)))!;
    expect(vmOne.rows.map(r => r.retirement)).toEqual(['Basic tier', 'TLS 1.0']);
    expect(outcome.summary.findings).toHaveLength(1);
    expect(outcome.summary.findings[0]!.rows).toHaveLength(2);

    const onlyDuplicates = await scan([ARG_RULE], { rows: [{ ...VM_TWO, n: 1 }, { ...VM_TWO, n: 1 }] }, 24);
    expect(onlyDuplicates.summary.findings.find(f => f.resourceId === String(VM_TWO.id))!.rows).toHaveLength(1);
  });

  it('keeps one scan blob finding per resource, carrying its rows, for Run History', async () => {
    const outcome = await scan([ARG_RULE], {
      rows: [{ ...VM_ONE, retirement: 'a' }, { ...VM_ONE, retirement: 'b' }],
    });
    expect(outcome.summary.findings).toHaveLength(1);
    expect(outcome.summary.findings[0]!.rows!.map(r => r.retirement)).toEqual(['a', 'b']);
    expect(outcome.summary.counts.medium).toBe(1);
  });

  it('refreshes the rows on every sync of an open finding, without touching its age or times seen', async () => {
    await scan([ARG_RULE], { rows: [{ ...VM_ONE, retirement: 'a' }, { ...VM_ONE, retirement: 'b' }] }, 0);
    await scan([ARG_RULE], { rows: [{ ...VM_ONE, retirement: 'b' }, { ...VM_ONE, retirement: 'c' }, { ...VM_ONE, retirement: 'd' }] }, 24);

    const found = (await findingFor(computeFingerprint(ARG_RULE, VM_ONE_ID)))!;
    expect(found.rows.map(r => r.retirement)).toEqual(['b', 'c', 'd']);
    expect(found.evidence.retirement).toBe('b');
    expect(found.status).toBe('active');
    expect(found.timesSeen).toBe(2);
    expect(found.firstSeenAt).toBe('2026-06-01T00:00:00.000Z');
    expect(found.lastSeenAt).toBe('2026-06-02T00:00:00.000Z');
  });

  it('keeps a suppression on a finding as its rows change', async () => {
    await scan([ARG_RULE], { rows: [{ ...VM_ONE, retirement: 'a' }] }, 0);
    const fingerprint = computeFingerprint(ARG_RULE, VM_ONE_ID);
    await saveSuppressions([{ id: 'sup-1', fingerprint, resourceId: VM_ONE_ID, reason: 'accepted', suppressedAt: '2026-06-01T00:00:00.000Z' }]);

    await scan([ARG_RULE], { rows: [{ ...VM_ONE, retirement: 'a' }, { ...VM_ONE, retirement: 'b' }] }, 24);

    expect((await queryActiveFindings(FILTERS)).map(f => f.fingerprint)).not.toContain(fingerprint);
    expect((await queryActiveFindingsWithRows({ ...FILTERS, includeSuppressed: true })).find(f => f.fingerprint === fingerprint)!.rows).toHaveLength(2);
  });

  it('keeps the same resource found by two rules as two findings, each with its own rows', async () => {
    await insertArgRule(OTHER_ARG_RULE);
    await scan([ARG_RULE, OTHER_ARG_RULE], { rows: [{ ...VM_ONE, n: 1 }, { ...VM_ONE, n: 2 }] });

    const stored = (await listFindings()).filter(f => f.resourceId === VM_ONE_ID);
    expect(stored.map(f => f.ruleId).sort()).toEqual([ARG_RULE, OTHER_ARG_RULE].sort());
    expect(new Set(stored.map(f => f.fingerprint)).size).toBe(2);
    expect(stored.every(f => f.rows.length === 2)).toBe(true);
  });
});

describe('Microsoft Graph rules', () => {
  beforeEach(async () => { await insertGraphRule(); });

  it('stores one finding holding every row Graph returned for one object, in query order', async () => {
    await scan([GRAPH_RULE], {
      graphRows: [
        { id: 'app-1', displayName: 'App One', owner: 'alice' },
        { id: 'app-2', displayName: 'App Two', owner: 'carol' },
        { id: 'app-1', displayName: 'App One', owner: 'bob' },
      ],
    });

    const stored = await listFindings();
    expect(stored).toHaveLength(2);
    const appOne = (await findingFor(computeFingerprint(GRAPH_RULE, 'applications/app-1')))!;
    expect(appOne.rows.map(r => r.owner)).toEqual(['alice', 'bob']);
    expect(appOne.evidence.owner).toBe('alice');
  });
});

describe('Logs rules', () => {
  beforeEach(async () => { await insertLogsRule(); });

  it('stores one finding per dimension value holding every row for it, in query order', async () => {
    await scan([LOGS_RULE], {
      logsRows: [
        { UserId: 'u1', ResultType: '50126' },
        { UserId: 'u2', ResultType: '50053' },
        { UserId: 'u1', ResultType: '50057' },
      ],
    });

    const stored = await listFindings();
    expect(stored.map(f => f.dimensionKey).sort()).toEqual(['u1', 'u2']);
    const userOne = (await findingFor(computeActivityFingerprint(LOGS_RULE, 'u1')))!;
    expect(userOne.kind).toBe('activity');
    expect(userOne.rows.map(r => r.ResultType)).toEqual(['50126', '50057']);
    expect(userOne.evidence.ResultType).toBe('50126');
    expect(userOne.timesSeen).toBe(1);
  });
});

describe('when a finding is Fixed', () => {
  const fingerprint = computeFingerprint(ARG_RULE, VM_ONE_ID);

  beforeEach(async () => {
    await insertArgRule();
    await scan([ARG_RULE], { rows: [{ ...VM_ONE, n: 1 }, { ...VM_ONE, n: 2 }] }, 0);
  });

  it('stays open, with its remaining row, while the rule still returns any row for the resource', async () => {
    await scan([ARG_RULE], { rows: [{ ...VM_ONE, n: 2 }] }, 24);
    const found = (await findingFor(fingerprint))!;
    expect(found.status).toBe('active');
    expect(found.rows).toEqual([{ n: 2 }]);
  });

  it('is Fixed when the rule succeeded and returned no rows for the resource', async () => {
    await scan([ARG_RULE], { rows: [{ ...VM_TWO, n: 1 }] }, 24);
    const found = (await findingFor(fingerprint))!;
    expect(found.status).toBe('fixed');
    expect(found.resolvedAt).toBe('2026-06-02T00:00:00.000Z');
  });

  it('is not Fixed when the rule failed', async () => {
    const outcome = await scan([ARG_RULE], { failWith: new Error('boom') }, 24);
    expect(outcome.summary.incompleteRules.map(r => r.status)).toEqual(['failed']);
    const found = (await findingFor(fingerprint))!;
    expect(found.status).toBe('active');
    expect(found.rows).toHaveLength(2);
  });

  it('is not Fixed when the rule was capped', async () => {
    await insertArgRule(ARG_RULE, `${ARG_KQL} | take 1`);
    const outcome = await scan([ARG_RULE], { rows: [] }, 24);
    expect(outcome.summary.incompleteRules.map(r => r.status)).toEqual(['capped']);
    expect((await findingFor(fingerprint))!.status).toBe('active');
  });

  it('is not Fixed, and keeps its rows, when the rule came back invalid', async () => {
    const outcome = await scan([ARG_RULE], { rows: [{ name: 'no-id', n: 9 }] }, 24);
    expect(outcome.summary.incompleteRules.map(r => r.status)).toEqual(['invalid']);
    const found = (await findingFor(fingerprint))!;
    expect(found.status).toBe('active');
    expect(found.rows).toHaveLength(2);
  });
});

describe('a finding stored before rows existed', () => {
  it('reads as one row made from its evidence, and keeps its age when the next scan adds rows', async () => {
    await insertArgRule();
    await scan([ARG_RULE], { rows: [{ ...VM_ONE, retirement: 'old' }] }, 0);
    const fingerprint = computeFingerprint(ARG_RULE, VM_ONE_ID);
    await execRun(db.update(findingsTable).set({ evidenceRows: null }).where(eq(findingsTable.fingerprint, fingerprint)));

    const upgraded = (await findingFor(fingerprint))!;
    expect(upgraded.rows).toEqual([{ retirement: 'old' }]);
    expect(upgraded.evidence).toEqual({ retirement: 'old' });

    await scan([ARG_RULE], { rows: [{ ...VM_ONE, retirement: 'old' }, { ...VM_ONE, retirement: 'new' }] }, 24);
    const rescanned = (await findingFor(fingerprint))!;
    expect(rescanned.rows.map(r => r.retirement)).toEqual(['old', 'new']);
    expect(rescanned.firstSeenAt).toBe('2026-06-01T00:00:00.000Z');
    expect(rescanned.timesSeen).toBe(2);
  });

  it('reads as no rows when it has neither stored rows nor evidence', async () => {
    await insertArgRule();
    await scan([ARG_RULE], { rows: [VM_ONE] }, 0);
    const fingerprint = computeFingerprint(ARG_RULE, VM_ONE_ID);
    await execRun(db.update(findingsTable).set({ evidenceRows: null, evidence: '{}' }).where(eq(findingsTable.fingerprint, fingerprint)));
    expect((await findingFor(fingerprint))!.rows).toEqual([]);
  });
});
