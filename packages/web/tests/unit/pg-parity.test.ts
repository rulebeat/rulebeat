/**
 * Issue #73 Phase 0 spike: backend parity for the ported repositories.
 *
 * Runs against whichever backend tests/setup.ts selected. On the default (SQLite) run this is
 * plain extra coverage; on the Postgres-scoped run (RULEBEAT_TEST_PG_URL set, only this file plus
 * notification-deliveries.test.ts executed) it is the proof that the dual-backend abstraction
 * behaves identically: same meta semantics, same finding lifecycle transitions, same fingerprint
 * lookups, same event counts.
 *
 * Deliberately stays at the repository layer and away from anything the spike did not port:
 * no deleteFindingsForRule (its trailing upsertDailySnapshot is SQLite-only until Phase 2), no
 * backfills (they read scan history through unported sync repositories), no dashboard-data
 * (loadRules is unported).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { computeFingerprint } from '@rulebeat/core';
import { getMeta, setMeta, deleteMeta } from '@/lib/db/meta';
import {
  syncScanFindings, listFindings, getFindingsByFingerprints, getFindingEventCounts,
} from '@/lib/db/findings';
import type { Finding } from '@/lib/types';
import { resetDb } from '../helpers/db';

const RULE_A = 'parity-rule-a';
const CATEGORY = 'security';
const DAY_MS = 86_400_000;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY_MS).toISOString();
}

function finding(resourceSuffix: string, overrides: Partial<Finding> = {}): Finding {
  const resourceId =
    `/subscriptions/sub-1/resourceGroups/rg1/providers/Microsoft.Compute/virtualMachines/${resourceSuffix}`;
  return {
    module: CATEGORY,
    ruleId: RULE_A,
    fingerprint: computeFingerprint(RULE_A, resourceId),
    severity: 'medium',
    category: CATEGORY,
    resourceId,
    resourceType: 'microsoft.compute/virtualmachines',
    resourceName: resourceSuffix,
    subscriptionId: 'sub-1',
    title: 'parity finding',
    description: 'test',
    evidence: {},
    recommendation: 'fix it',
    remediationSteps: [],
    detectedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(async () => {
  await resetDb();
});

describe('meta repository parity', () => {
  it('set, read back, overwrite, delete', async () => {
    expect(await getMeta('parity-key')).toBeNull();

    await setMeta('parity-key', 'v1');
    expect(await getMeta('parity-key')).toBe('v1');

    // Upsert semantics: a second set for the same key replaces, never duplicates or throws.
    await setMeta('parity-key', 'v2');
    expect(await getMeta('parity-key')).toBe('v2');

    await deleteMeta('parity-key');
    expect(await getMeta('parity-key')).toBeNull();

    // Deleting a missing key is a no-op, not an error.
    await deleteMeta('parity-key');
  });
});

describe('findings lifecycle parity', () => {
  it('create, repeat, resolve, reactivate produce the same rows and events', async () => {
    const f = finding('vm-parity');
    const d1 = daysAgo(3);
    const d2 = daysAgo(2);
    const d3 = daysAgo(1);

    // Created.
    const created = await syncScanFindings({
      scanId: 'p1', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: d1,
    });
    expect(created.created).toEqual([f.fingerprint]);
    let row = (await listFindings()).find(r => r.fingerprint === f.fingerprint)!;
    expect(row.status).toBe('active');
    expect(row.firstSeenAt).toBe(d1);
    expect(row.lastSeenAt).toBe(d1);
    expect(row.timesSeen).toBe(1);

    // Repeat sighting: timesSeen increments, lastSeenAt advances, firstSeenAt does not move.
    await syncScanFindings({
      scanId: 'p2', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: d2,
    });
    row = (await listFindings()).find(r => r.fingerprint === f.fingerprint)!;
    expect(row.status).toBe('active');
    expect(row.firstSeenAt).toBe(d1);
    expect(row.lastSeenAt).toBe(d2);
    expect(row.timesSeen).toBe(2);

    // Resolved: the rule ran successfully and returned nothing.
    const resolved = await syncScanFindings({
      scanId: 'p3', category: CATEGORY, ranRuleIds: [RULE_A], findings: [], finishedAt: d3,
    });
    expect(resolved.resolved).toEqual([f.fingerprint]);
    row = (await listFindings()).find(r => r.fingerprint === f.fingerprint)!;
    expect(row.status).toBe('fixed');
    expect(row.resolvedAt).toBe(d3);

    // Reactivated: the same fingerprint comes back.
    const reactivated = await syncScanFindings({
      scanId: 'p4', category: CATEGORY, ranRuleIds: [RULE_A], findings: [f], finishedAt: daysAgo(0),
    });
    expect(reactivated.reactivated).toEqual([f.fingerprint]);
    row = (await listFindings()).find(r => r.fingerprint === f.fingerprint)!;
    expect(row.status).toBe('active');
    expect(row.resolvedAt).toBeUndefined();

    // The event trail recorded each transition, visible through the counts API.
    const counts = await getFindingEventCounts({ sinceDate: daysAgo(5).slice(0, 10) });
    const totals = { created: 0, resolved: 0 };
    for (const c of counts) {
      totals.created += c.created;
      totals.resolved += c.resolved;
    }
    // created + reactivated both count as "new" days; one resolve counts as fixed.
    expect(totals.created).toBe(2);
    expect(totals.resolved).toBe(1);
  });

  it('getFindingsByFingerprints returns exactly the asked-for rows', async () => {
    const a = finding('vm-a');
    const b = finding('vm-b');
    await syncScanFindings({
      scanId: 'p1', category: CATEGORY, ranRuleIds: [RULE_A], findings: [a, b], finishedAt: daysAgo(1),
    });

    const rows = await getFindingsByFingerprints([a.fingerprint]);
    expect(rows.map(r => r.fingerprint)).toEqual([a.fingerprint]);
    expect(await getFindingsByFingerprints([])).toEqual([]);
  });

  it('status filter on listFindings matches the lifecycle state', async () => {
    const a = finding('vm-a');
    const b = finding('vm-b');
    await syncScanFindings({
      scanId: 'p1', category: CATEGORY, ranRuleIds: [RULE_A], findings: [a, b], finishedAt: daysAgo(2),
    });
    await syncScanFindings({
      scanId: 'p2', category: CATEGORY, ranRuleIds: [RULE_A], findings: [a], finishedAt: daysAgo(1),
    });

    expect((await listFindings({ status: 'active' })).map(r => r.fingerprint)).toEqual([a.fingerprint]);
    expect((await listFindings({ status: 'fixed' })).map(r => r.fingerprint)).toEqual([b.fingerprint]);
    expect(await listFindings()).toHaveLength(2);
  });
});
