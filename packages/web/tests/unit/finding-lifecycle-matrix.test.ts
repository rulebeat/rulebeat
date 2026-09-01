/**
 * Codex review Phase 5, item 2: the complete finding lifecycle matrix.
 *
 * scan-lifecycle-coverage.test.ts already covers the dangerous partial-scan transition (spec
 * 004/005) through the full await runCategoryScan() pipeline. This suite is the rest of the matrix
 * Codex asked for, unit-level against await syncScanFindings() itself (lib/db/findings.ts) plus the
 * suppression-window behaviour findings pass through at read time (lib/dashboard-data.ts):
 *  - created / repeat / resolved / reactivated, and what happens to firstSeenAt/lastSeenAt/
 *    resolvedAt/timesSeen at each transition
 *  - event type and occurredAt for each transition (occurredAt uses the scan's own finishedAt,
 *    never wall-clock "now" — see the comment in findings.ts explaining why that matters for replay)
 *  - the 500-row CHUNK_SIZE boundary, on both the findings side and the ranRuleIds side
 *  - a rule's findings and events both disappearing when the rule is deleted
 *  - event-retention pruning (findings.ts prunes finding_events older than 180 days on every sync)
 *  - expired vs. permanent suppressions, read through await queryActiveFindings()
 *
 * Duplicate ARG rows sharing one fingerprint within a single scan are covered below (RB-QA-019,
 * fixed via dedupeFindingsByFingerprint()) — one sighting per fingerprint regardless of how many
 * times it appeared in the scan's own findings array.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, asc } from 'drizzle-orm';
import { computeFingerprint } from '@rulebeat/core';
import { db } from '@/lib/db/client';
import { run as execRun, many as execMany } from '@/lib/db/exec';
import { findingEvents as findingEventsTable } from '@/lib/db/tables';
import { syncScanFindings, listFindings, deleteFindingsForRule } from '@/lib/db/findings';
import { queryActiveFindings } from '@/lib/dashboard-data';
import { saveSuppressions } from '@/lib/suppressions';
import type { WidgetFilters } from '@/lib/dashboard-filters';
import type { Finding, Suppression } from '@/lib/types';
import { resetDb } from '../helpers/db';

const RULE_A = 'test-rule-a';
const CATEGORY = 'security';
const FILTERS: WidgetFilters = { dateWindow: { mode: 'relative', days: 7 } };
const DAY_MS = 86_400_000;

/** Days before "now" — must stay well inside the 180-day event-retention window (findings.ts
 *  prunes finding_events older than that on every non-silent sync), or a fixture date that reads
 *  as "recent" in the source only by coincidence of when this file was written silently loses its
 *  own events the moment enough real time has passed. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY_MS).toISOString();
}

function finding(resourceSuffix: string, overrides: Partial<Finding> & { ruleId?: string } = {}): Finding {
  const ruleId = overrides.ruleId ?? RULE_A;
  const resourceId = overrides.resourceId
    ?? `/subscriptions/sub-1/resourceGroups/rg1/providers/Microsoft.Compute/virtualMachines/${resourceSuffix}`;
  return {
    module: CATEGORY,
    ruleId,
    fingerprint: computeFingerprint(ruleId, resourceId),
    severity: 'medium',
    category: CATEGORY,
    resourceId,
    resourceType: 'microsoft.compute/virtualmachines',
    resourceName: resourceSuffix,
    subscriptionId: 'sub-1',
    title: 'test finding',
    description: 'test',
    evidence: {},
    recommendation: 'fix it',
    remediationSteps: [],
    detectedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function eventsFor(fingerprint: string) {
  return (await execMany(db.select().from(findingEventsTable)
    .where(eq(findingEventsTable.fingerprint, fingerprint))
    .orderBy(asc(findingEventsTable.occurredAt))));
}

function suppression(overrides: Partial<Suppression> & Pick<Suppression, 'fingerprint' | 'resourceId'>): Suppression {
  return { id: crypto.randomUUID(), reason: 'test', suppressedAt: '2026-01-01T00:00:00.000Z', ...overrides };
}

beforeEach(async () => {
  await resetDb();
});

describe('syncScanFindings — created / repeat / resolved / reactivated', () => {
  it('creates a new finding as active, firstSeenAt = lastSeenAt = the scan\'s finishedAt, timesSeen 1, one created event', async () => {
    const f = finding('vm-1');
    const d1 = daysAgo(3);
    const result = await syncScanFindings({ scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: d1 });

    expect(result).toEqual({ created: [f.fingerprint], reactivated: [], resolved: [] });
    const row = (await listFindings()).find(r => r.fingerprint === f.fingerprint)!;
    expect(row.status).toBe('active');
    expect(row.firstSeenAt).toBe(d1);
    expect(row.lastSeenAt).toBe(d1);
    expect(row.resolvedAt).toBeUndefined();
    expect(row.timesSeen).toBe(1);

    const events = await eventsFor(f.fingerprint);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('created');
    expect(events[0]!.occurredAt).toBe(d1);
  });

  it('a finding seen again advances lastSeenAt and timesSeen, keeps firstSeenAt, and records no new event', async () => {
    const f = finding('vm-1');
    const d1 = daysAgo(3);
    const d2 = daysAgo(2);
    await syncScanFindings({ scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: d1 });
    const result = await syncScanFindings({ scanId: 's2', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: d2 });

    expect(result).toEqual({ created: [], reactivated: [], resolved: [] });
    const row = (await listFindings()).find(r => r.fingerprint === f.fingerprint)!;
    expect(row.firstSeenAt).toBe(d1);
    expect(row.lastSeenAt).toBe(d2);
    expect(row.timesSeen).toBe(2);
    expect(await eventsFor(f.fingerprint)).toHaveLength(1);
  });

  it('a finding that stops appearing resolves: status fixed, resolvedAt set, one resolved event', async () => {
    const f = finding('vm-1');
    const d1 = daysAgo(3);
    const d2 = daysAgo(2);
    await syncScanFindings({ scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: d1 });
    const result = await syncScanFindings({ scanId: 's2', category: CATEGORY, ranRuleIds: [RULE_A], findings: [], finishedAt: d2 });

    expect(result).toEqual({ created: [], reactivated: [], resolved: [f.fingerprint] });
    const row = (await listFindings()).find(r => r.fingerprint === f.fingerprint)!;
    expect(row.status).toBe('fixed');
    expect(row.resolvedAt).toBe(d2);

    const events = await eventsFor(f.fingerprint);
    expect(events.map(e => e.type)).toEqual(['created', 'resolved']);
  });

  it('a fixed finding reappearing reactivates: status active, resolvedAt cleared, firstSeenAt preserved, one reactivated event', async () => {
    const f = finding('vm-1');
    const d1 = daysAgo(3);
    const d2 = daysAgo(2);
    const d3 = daysAgo(1);
    await syncScanFindings({ scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: d1 });
    await syncScanFindings({ scanId: 's2', category: CATEGORY, ranRuleIds: [RULE_A], findings: [], finishedAt: d2 });
    const result = await syncScanFindings({ scanId: 's3', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: d3 });

    expect(result).toEqual({ created: [], reactivated: [f.fingerprint], resolved: [] });
    const row = (await listFindings()).find(r => r.fingerprint === f.fingerprint)!;
    expect(row.status).toBe('active');
    expect(row.resolvedAt).toBeUndefined();
    expect(row.firstSeenAt).toBe(d1);
    expect(row.lastSeenAt).toBe(d3);

    const events = await eventsFor(f.fingerprint);
    expect(events.map(e => e.type)).toEqual(['created', 'resolved', 'reactivated']);
    expect(events[2]!.occurredAt).toBe(d3);
  });
});

describe('syncScanFindings — 500-row CHUNK_SIZE boundary', () => {
  it('classifies and resolves correctly across a findings list spanning two chunks (>500)', async () => {
    const many = Array.from({ length: 501 }, (_, i) => finding(`vm-${i}`));
    const result = await syncScanFindings({ scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_A], findings: many, finishedAt: daysAgo(2) });
    expect(result.created).toHaveLength(501);
    expect(await listFindings({ status: 'active' })).toHaveLength(501);

    // Only the first row survives — the other 500 must resolve, exercising the same chunk
    // boundary on the resolve side (both the seen-set lookup and the resolve UPDATE are chunked).
    const result2 = await syncScanFindings({ scanId: 's2', category: CATEGORY, ranRuleIds: [RULE_A], findings: [many[0]!], finishedAt: daysAgo(1) });
    expect(result2.resolved).toHaveLength(500);
    expect(await listFindings({ status: 'active' })).toHaveLength(1);
    expect(await listFindings({ status: 'fixed' })).toHaveLength(500);
  });

  it('resolves stale findings correctly when ranRuleIds itself spans more than 500 ids', async () => {
    // 501 distinct rules, one finding each, seeded and reported as ran in a single call — this
    // exercises the ranRuleIds chunking loop (a second, independent chunk boundary from the one
    // above), not just the findings-list chunking loop.
    const manyFindings = Array.from({ length: 501 }, (_, i) => finding(`vm-${i}`, { ruleId: `rule-${i}` }));
    const ranRuleIds = manyFindings.map(f => f.ruleId);
    await syncScanFindings({ scanId: 's0', category: CATEGORY, ranRuleIds, findings: manyFindings, finishedAt: daysAgo(2) });
    expect(await listFindings({ status: 'active' })).toHaveLength(501);

    const result = await syncScanFindings({ scanId: 's1', category: CATEGORY, ranRuleIds, findings: [], finishedAt: daysAgo(1) });
    expect(result.resolved).toHaveLength(501);
    expect(await listFindings({ status: 'active' })).toHaveLength(0);
  });
});

describe('deleteFindingsForRule', () => {
  it('removes both the findings row and its finding_events rows for that rule', async () => {
    const f = finding('vm-1');
    await syncScanFindings({ scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: daysAgo(1) });
    expect(await listFindings()).toHaveLength(1);
    expect(await eventsFor(f.fingerprint)).toHaveLength(1);

    await deleteFindingsForRule(RULE_A);

    expect(await listFindings()).toHaveLength(0);
    expect(await eventsFor(f.fingerprint)).toHaveLength(0);
  });
});

describe('event-retention pruning', () => {
  it('prunes a finding_events row older than 180 days on the next non-silent sync', async () => {
    const f = finding('vm-old');
    await syncScanFindings({ scanId: 's0', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: daysAgo(1) });
    expect(await eventsFor(f.fingerprint)).toHaveLength(1);

    // Seeding a 200-day-old event via syncScanFindings itself is impossible — its own prune step
    // would delete anything that old inside the very same call that inserted it. Insert directly
    // to simulate history that predates the 180-day retention window.
    const oldDate = daysAgo(200);
    await execRun(db.insert(findingEventsTable).values({
      id: crypto.randomUUID(), fingerprint: f.fingerprint, ruleId: f.ruleId, category: CATEGORY,
      scanId: 'old-scan', type: 'created', occurredAt: oldDate,
    }));
    expect(await eventsFor(f.fingerprint)).toHaveLength(2);

    // Any later non-silent sync's prune step runs unconditionally at the end of its transaction —
    // resolving f's own finding here also proves the just-written 'resolved' event survives while
    // the 200-day-old synthetic event for the same fingerprint gets pruned.
    await syncScanFindings({ scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_A], findings: [], finishedAt: new Date().toISOString() });

    const remaining = await eventsFor(f.fingerprint);
    expect(remaining.map(e => e.type)).toEqual(['created', 'resolved']);
    expect(remaining.some(e => e.occurredAt === oldDate)).toBe(false);
  });
});

describe('duplicate ARG rows sharing one fingerprint (RB-QA-019, fixed)', () => {
  it('a single scan returning the same resource twice counts as one sighting, not two', async () => {
    const f = finding('vm-dup');
    const result = await syncScanFindings({ scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f, f], finishedAt: daysAgo(1) });

    expect(result.created).toEqual([f.fingerprint]);
    const row = (await listFindings()).find(r => r.fingerprint === f.fingerprint)!;
    expect(row.timesSeen).toBe(1);
    expect(await eventsFor(f.fingerprint)).toHaveLength(1);
  });

  it('a duplicate row for a currently-fixed finding reactivates it exactly once', async () => {
    const f = finding('vm-dup-reactivate');
    const d1 = daysAgo(3);
    const d2 = daysAgo(2);
    const d3 = daysAgo(1);
    await syncScanFindings({ scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: d1 });
    await syncScanFindings({ scanId: 's2', category: CATEGORY, ranRuleIds: [RULE_A], findings: [], finishedAt: d2 });
    const result = await syncScanFindings({ scanId: 's3', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f, f], finishedAt: d3 });

    expect(result.reactivated).toEqual([f.fingerprint]);
    const row = (await listFindings()).find(r => r.fingerprint === f.fingerprint)!;
    expect(row.status).toBe('active');
    expect(row.timesSeen).toBe(2);
    expect((await eventsFor(f.fingerprint)).map(e => e.type)).toEqual(['created', 'resolved', 'reactivated']);
  });

  it('when duplicates differ in fields, the last occurrence in the array wins', async () => {
    const f1 = finding('vm-dup-fields', { description: 'first observation' });
    const f2 = { ...f1, description: 'second observation' };
    await syncScanFindings({ scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f1, f2], finishedAt: daysAgo(1) });

    const row = (await listFindings()).find(r => r.fingerprint === f1.fingerprint)!;
    expect(row.description).toBe('second observation');
  });

  it('a duplicate for one fingerprint does not affect an unrelated fingerprint\'s resolved/reactivated classification', async () => {
    const dup = finding('vm-dup-isolated');
    const other = finding('vm-other-isolated');
    const d1 = daysAgo(2);
    const d2 = daysAgo(1);
    await syncScanFindings({ scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_A], findings: [dup, other], finishedAt: d1 });
    const result = await syncScanFindings({ scanId: 's2', category: CATEGORY, ranRuleIds: [RULE_A], findings: [dup, dup], finishedAt: d2 });

    expect(result.resolved).toEqual([other.fingerprint]);
    expect(result.created).toEqual([]);
    expect(result.reactivated).toEqual([]);
  });
});

describe('active vs. expired suppressions (queryActiveFindings)', () => {
  it('a permanent suppression (no expiresAt) excludes the finding from active results', async () => {
    const f = finding('vm-1');
    await syncScanFindings({ scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: '2026-01-01T00:00:00.000Z' });
    await saveSuppressions([suppression({ fingerprint: f.fingerprint, resourceId: f.resourceId })]);

    expect((await queryActiveFindings(FILTERS)).map(r => r.fingerprint)).not.toContain(f.fingerprint);
  });

  it('a suppression with a future expiresAt still excludes the finding', async () => {
    const f = finding('vm-1');
    await syncScanFindings({ scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: '2026-01-01T00:00:00.000Z' });
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
    await saveSuppressions([suppression({ fingerprint: f.fingerprint, resourceId: f.resourceId, expiresAt: future })]);

    expect((await queryActiveFindings(FILTERS)).map(r => r.fingerprint)).not.toContain(f.fingerprint);
  });

  it('an expired suppression no longer excludes the finding', async () => {
    const f = finding('vm-1');
    await syncScanFindings({ scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: '2026-01-01T00:00:00.000Z' });
    const past = new Date(Date.now() - 1 * 86_400_000).toISOString();
    await saveSuppressions([suppression({ fingerprint: f.fingerprint, resourceId: f.resourceId, expiresAt: past })]);

    expect((await queryActiveFindings(FILTERS)).map(r => r.fingerprint)).toContain(f.fingerprint);
  });

  it('filters.includeSuppressed bypasses even a permanent suppression', async () => {
    const f = finding('vm-1');
    await syncScanFindings({ scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: '2026-01-01T00:00:00.000Z' });
    await saveSuppressions([suppression({ fingerprint: f.fingerprint, resourceId: f.resourceId })]);

    expect((await queryActiveFindings({ ...FILTERS, includeSuppressed: true })).map(r => r.fingerprint)).toContain(f.fingerprint);
  });
});
