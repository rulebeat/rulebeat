/**
 * Spec 034 (activity findings): kind:'activity' has no resource, fingerprints on
 * ruleId+dimensionKey (namespaced so it can never collide with a state fingerprint for the same
 * rule), never resolves via the normal resolve sweep — it ages out of a read-time window instead
 * — and suppresses through the existing fingerprint-only mechanism now that resourceId is
 * optional on both Finding and Suppression.
 *
 * Companion to finding-lifecycle-matrix.test.ts, which covers the kind:'state' lifecycle this
 * file assumes as a baseline (created/repeat/resolved/reactivated, event types, chunk boundaries,
 * suppression expiry). This file covers only what's different for kind:'activity'.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, asc } from 'drizzle-orm';
import { computeActivityFingerprint, computeFingerprint } from '@rulebeat/core';
import { db } from '@/lib/db/client';
import { findingEvents as findingEventsTable } from '@/lib/db/schema';
import { syncScanFindings, listFindings, getActivityOccurrenceCounts } from '@/lib/db/findings';
import { queryActiveFindings } from '@/lib/dashboard-data';
import { saveSuppressions, loadSuppressions, isActiveSuppression } from '@/lib/suppressions';
import type { WidgetFilters } from '@/lib/dashboard-filters';
import type { Finding, Suppression } from '@/lib/types';
import { resetDb } from '../helpers/db';

const RULE_A = 'test-activity-rule-a';
const RULE_B = 'test-state-rule-b';
const CATEGORY = 'security';
const FILTERS: WidgetFilters = { dateWindow: { mode: 'relative', days: 7 } };
const DAY_MS = 86_400_000;

/** See finding-lifecycle-matrix.test.ts's identical helper for why this must stay well inside
 *  the 180-day event-retention window. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY_MS).toISOString();
}

function activityFinding(dimensionKey: string, overrides: Partial<Finding> & { ruleId?: string } = {}): Finding {
  const ruleId = overrides.ruleId ?? RULE_A;
  return {
    module: CATEGORY,
    ruleId,
    fingerprint: computeActivityFingerprint(ruleId, dimensionKey),
    kind: 'activity',
    dimensionKey,
    severity: 'medium',
    category: CATEGORY,
    subscriptionId: 'sub-1',
    title: 'test activity finding',
    description: 'test',
    evidence: {},
    recommendation: 'investigate',
    remediationSteps: [],
    detectedAt: new Date().toISOString(),
    ...overrides,
  };
}

function stateFinding(resourceSuffix: string, overrides: Partial<Finding> & { ruleId?: string } = {}): Finding {
  const ruleId = overrides.ruleId ?? RULE_B;
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
    title: 'test state finding',
    description: 'test',
    evidence: {},
    recommendation: 'fix it',
    remediationSteps: [],
    detectedAt: new Date().toISOString(),
    ...overrides,
  };
}

function eventsFor(fingerprint: string) {
  return db.select().from(findingEventsTable)
    .where(eq(findingEventsTable.fingerprint, fingerprint))
    .orderBy(asc(findingEventsTable.occurredAt))
    .all();
}

function suppression(overrides: Partial<Suppression> & Pick<Suppression, 'fingerprint'>): Suppression {
  return { id: crypto.randomUUID(), reason: 'test', suppressedAt: '2026-01-01T00:00:00.000Z', ...overrides };
}

beforeEach(async () => {
  await resetDb();
});

describe('syncScanFindings — activity finding creation and repeat occurrence', () => {
  it('creates an activity finding with kind, dimensionKey, and no resource fields; one created event', async () => {
    const f = activityFinding('principal-a');
    const d1 = daysAgo(3);
    const result = await syncScanFindings({ scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: d1 });

    expect(result).toEqual({ created: [f.fingerprint], reactivated: [], resolved: [] });
    const row = (await listFindings()).find(r => r.fingerprint === f.fingerprint)!;
    expect(row.kind).toBe('activity');
    expect(row.dimensionKey).toBe('principal-a');
    expect(row.resourceId).toBeUndefined();
    expect(row.resourceType).toBeUndefined();
    expect(row.resourceName).toBeUndefined();
    expect(row.timesSeen).toBe(1);

    const events = eventsFor(f.fingerprint);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('created');
  });

  it('a repeat occurrence advances lastSeenAt/timesSeen and records an "occurred" event, not "created" or "reactivated"', async () => {
    const f = activityFinding('principal-a');
    const d1 = daysAgo(3);
    const d2 = daysAgo(2);
    await syncScanFindings({ scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: d1 });
    const result = await syncScanFindings({ scanId: 's2', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: d2 });

    expect(result).toEqual({ created: [], reactivated: [], resolved: [] });
    const row = (await listFindings()).find(r => r.fingerprint === f.fingerprint)!;
    expect(row.status).toBe('active');
    expect(row.firstSeenAt).toBe(d1);
    expect(row.lastSeenAt).toBe(d2);
    expect(row.timesSeen).toBe(2);

    expect(eventsFor(f.fingerprint).map(e => e.type)).toEqual(['created', 'occurred']);
  });

  it('multiple repeat occurrences each record their own "occurred" event', async () => {
    const f = activityFinding('principal-a');
    await syncScanFindings({ scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: daysAgo(4) });
    await syncScanFindings({ scanId: 's2', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: daysAgo(3) });
    await syncScanFindings({ scanId: 's3', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: daysAgo(2) });

    const row = (await listFindings()).find(r => r.fingerprint === f.fingerprint)!;
    expect(row.timesSeen).toBe(3);
    expect(eventsFor(f.fingerprint).map(e => e.type)).toEqual(['created', 'occurred', 'occurred']);
  });
});

describe('syncScanFindings — an activity finding never resolves via the resolve sweep (spec 034)', () => {
  it('regression: a rule not re-reporting an activity finding this scan does not resolve it', async () => {
    const f = activityFinding('principal-a');
    const d1 = daysAgo(3);
    const d2 = daysAgo(2);
    await syncScanFindings({ scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: d1 });

    // The rule ran again (it's in ranRuleIds) but reported nothing this time. For a resource-scoped
    // rule that means "fixed"; for an activity rule going quiet says nothing about whether the
    // underlying pattern is still relevant, so it must stay active.
    const result = await syncScanFindings({ scanId: 's2', category: CATEGORY, ranRuleIds: [RULE_A], findings: [], finishedAt: d2 });

    expect(result.resolved).toEqual([]);
    const row = (await listFindings()).find(r => r.fingerprint === f.fingerprint)!;
    expect(row.status).toBe('active');
    expect(row.resolvedAt).toBeUndefined();
    expect(eventsFor(f.fingerprint).map(e => e.type)).toEqual(['created']);
  });

  it('cross-contamination: a state finding from the same rule/category still resolves normally when a sibling activity finding does not', async () => {
    // Same rule id deliberately shared by both findings, to isolate that the resolve sweep's
    // kind:'state' filter — not some incidental per-rule scoping — is what protects the activity
    // finding.
    const activity = activityFinding('principal-a', { ruleId: RULE_A });
    const state = stateFinding('vm-1', { ruleId: RULE_A });
    const d1 = daysAgo(3);
    const d2 = daysAgo(2);
    await syncScanFindings({ scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_A], findings: [activity, state], finishedAt: d1 });

    const result = await syncScanFindings({ scanId: 's2', category: CATEGORY, ranRuleIds: [RULE_A], findings: [], finishedAt: d2 });

    expect(result.resolved).toEqual([state.fingerprint]);
    expect((await listFindings()).find(r => r.fingerprint === activity.fingerprint)!.status).toBe('active');
    expect((await listFindings()).find(r => r.fingerprint === state.fingerprint)!.status).toBe('fixed');
  });
});

describe('getActivityOccurrenceCounts', () => {
  it('counts only kind:\'activity\' events, excluding a kind:\'state\' finding\'s created event on the same day', async () => {
    const activity = activityFinding('principal-a');
    const state = stateFinding('vm-1');
    const d1 = daysAgo(2);
    await syncScanFindings({ scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_A, RULE_B], findings: [activity, state], finishedAt: d1 });

    const counts = await getActivityOccurrenceCounts({ sinceDate: daysAgo(5).slice(0, 10) });
    expect(counts.find(c => c.date === d1.slice(0, 10))?.count).toBe(1);
  });

  it('a repeat occurrence adds a second data point on its own day', async () => {
    const f = activityFinding('principal-a');
    const d1 = daysAgo(3);
    const d2 = daysAgo(2);
    await syncScanFindings({ scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: d1 });
    await syncScanFindings({ scanId: 's2', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: d2 });

    const counts = await getActivityOccurrenceCounts({ sinceDate: daysAgo(5).slice(0, 10) });
    expect(counts.find(c => c.date === d1.slice(0, 10))?.count).toBe(1);
    expect(counts.find(c => c.date === d2.slice(0, 10))?.count).toBe(1);
  });

  it('filters by category, ruleIds, subscriptions, and severities', async () => {
    const f = activityFinding('principal-a', { severity: 'high', subscriptionId: 'sub-x' });
    const d1 = daysAgo(2);
    await syncScanFindings({ scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: d1 });
    const day = d1.slice(0, 10);
    const since = daysAgo(5).slice(0, 10);

    expect((await getActivityOccurrenceCounts({ sinceDate: since, categories: [CATEGORY] })).find(c => c.date === day)?.count).toBe(1);
    expect((await getActivityOccurrenceCounts({ sinceDate: since, categories: ['cost'] })).find(c => c.date === day)).toBeUndefined();
    expect((await getActivityOccurrenceCounts({ sinceDate: since, ruleIds: [RULE_A] })).find(c => c.date === day)?.count).toBe(1);
    expect((await getActivityOccurrenceCounts({ sinceDate: since, ruleIds: ['nope'] })).find(c => c.date === day)).toBeUndefined();
    expect((await getActivityOccurrenceCounts({ sinceDate: since, subscriptions: ['sub-x'] })).find(c => c.date === day)?.count).toBe(1);
    expect((await getActivityOccurrenceCounts({ sinceDate: since, subscriptions: ['sub-other'] })).find(c => c.date === day)).toBeUndefined();
    expect((await getActivityOccurrenceCounts({ sinceDate: since, severities: ['high'] })).find(c => c.date === day)?.count).toBe(1);
    expect((await getActivityOccurrenceCounts({ sinceDate: since, severities: ['low'] })).find(c => c.date === day)).toBeUndefined();
  });
});

describe('suppression round-trip with no resourceId (activity findings)', () => {
  it('a suppression for an activity finding pattern persists and reloads with resourceId absent', async () => {
    const f = activityFinding('principal-a');
    await syncScanFindings({ scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: daysAgo(1) });
    await saveSuppressions([suppression({ fingerprint: f.fingerprint })]);

    const loaded = await loadSuppressions();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.resourceId).toBeUndefined();
    expect(isActiveSuppression(loaded[0]!)).toBe(true);
  });

  it('queryActiveFindings excludes a suppressed activity finding by fingerprint alone', async () => {
    const f = activityFinding('principal-a');
    await syncScanFindings({ scanId: 's1', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: daysAgo(1) });
    await saveSuppressions([suppression({ fingerprint: f.fingerprint })]);

    expect((await queryActiveFindings(FILTERS)).map(r => r.fingerprint)).not.toContain(f.fingerprint);
    expect((await queryActiveFindings({ ...FILTERS, includeSuppressed: true })).map(r => r.fingerprint)).toContain(f.fingerprint);
  });
});
