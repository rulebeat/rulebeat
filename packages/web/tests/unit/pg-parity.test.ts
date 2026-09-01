/**
 * Issue #73 Phase 0 spike: backend parity for the ported repositories.
 *
 * Runs against whichever backend tests/setup.ts selected. On the default (SQLite) run this is
 * plain extra coverage; on the Postgres run (RULEBEAT_TEST_PG_URL set, as CI's test-postgres job
 * does) it is the proof that the dual-backend abstraction behaves identically: same meta
 * semantics, same finding lifecycle transitions, same fingerprint lookups, same event counts.
 *
 * Phase 3 widened it beyond the spike's repositories: rules (a save/load round-trip carrying the
 * seeded packs' real KQL), users (including the raw-SQL session-epoch bump and both last-admin
 * guards), dashboards (first-row default, promotion on delete, duplication) and suppressions.
 * Still deliberately at the repository layer: route handlers and the scan flow have their own
 * suites, which the Postgres CI job runs in full.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { computeFingerprint } from '@rulebeat/core';
import { getMeta, setMeta, deleteMeta } from '@/lib/db/meta';
import {
  syncScanFindings, listFindings, getFindingsByFingerprints, getFindingEventCounts,
} from '@/lib/db/findings';
import type { Rule } from '@rulebeat/core';
import { loadRules, saveRules } from '@/lib/rules';
import { loadSuppressions, saveSuppressions, isActiveSuppression } from '@/lib/suppressions';
import {
  createUser, getUser, listUsers, updateUserRole, deleteUser, bumpSessionEpoch, countAdmins,
} from '@/lib/db/users';
import {
  createDashboard, getDashboard, listDashboards, updateDashboard, deleteDashboard,
  duplicateDashboard,
} from '@/lib/db/dashboards';
import type { Finding, Suppression } from '@/lib/types';
import { resetDb, clearDashboards } from '../helpers/db';

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

describe('rules repository parity', () => {
  it('saveRules round-trips every seeded rule byte-identically, KQL included', async () => {
    const before = await loadRules();
    expect(before.length).toBeGreaterThan(0);
    // The interesting payload is the packs' real KQL, not a synthetic fixture.
    expect(before.some(r => r.rawKql), 'expected seeded rules with raw KQL').toBe(true);

    // saveRules is delete + full reinsert, so a field either survives ruleToRow/rowToRule on this
    // backend or this comparison catches it.
    await saveRules(before);

    const byId = (rs: Rule[]) => [...rs].sort((a, b) => a.id.localeCompare(b.id));
    expect(byId(await loadRules())).toEqual(byId(before));
  });
});

describe('users repository parity', () => {
  it('create normalizes email; duplicate and last-admin guards hold; epoch bumps in SQL', async () => {
    const created = await createUser({ email: '  Parity@Example.COM ', role: 'admin' });
    if ('error' in created) throw new Error(created.error);
    const admin = created.user;
    expect(admin.email).toBe('parity@example.com');
    expect(await countAdmins()).toBe(1);

    // Same email again, any casing: refused.
    expect(await createUser({ email: 'parity@example.com', role: 'viewer' })).toHaveProperty('error');

    // The only admin can neither be demoted nor deleted.
    expect(await updateUserRole(admin.id, 'viewer')).toHaveProperty('error');
    expect(await deleteUser(admin.id)).toBe('last-admin');

    // bumpSessionEpoch increments through a raw SQL fragment, a dialect-sensitive path worth proving.
    await bumpSessionEpoch(admin.id);
    expect((await getUser(admin.id))!.sessionEpoch).toBe(admin.sessionEpoch + 1);

    // With a second admin present, deletion goes through.
    const second = await createUser({ email: 'second@example.com', role: 'admin' });
    if ('error' in second) throw new Error(second.error);
    expect(await deleteUser(admin.id)).toBe(true);
    expect((await listUsers()).map(u => u.email)).toEqual(['second@example.com']);
  });
});

describe('dashboards repository parity', () => {
  it('first row defaults, name collisions refuse, duplicate copies config, delete promotes', async () => {
    await clearDashboards();

    const a = await createDashboard({ name: 'Parity A', description: 'first', config: { widgets: [] } });
    if ('error' in a) throw new Error(a.error);
    expect(a.dashboard.isDefault).toBe(true); // very first dashboard in an empty table

    const b = await createDashboard({ name: 'Parity B', config: { widgets: [], autoRefresh: 30 } });
    if ('error' in b) throw new Error(b.error);
    expect(b.dashboard.isDefault).toBe(false);

    // Collisions are case-insensitive, on create and rename alike.
    expect(await createDashboard({ name: 'parity a', config: { widgets: [] } })).toHaveProperty('error');
    expect(await updateDashboard(b.dashboard.id, { name: 'PARITY A' })).toHaveProperty('error');

    const dup = await duplicateDashboard(a.dashboard.id);
    expect(dup).not.toBeNull();
    expect(dup!.id).not.toBe(a.dashboard.id);
    expect(dup!.name).toBe('Parity A (copy)');
    expect(dup!.config).toEqual(a.dashboard.config);

    // Deleting the default promotes exactly one remaining dashboard, in the same transaction.
    expect(await deleteDashboard(a.dashboard.id)).toBe(true);
    expect(await getDashboard(a.dashboard.id)).toBeNull();
    const remaining = await listDashboards();
    expect(remaining).toHaveLength(2);
    expect(remaining.filter(d => d.isDefault)).toHaveLength(1);
  });
});

describe('suppressions repository parity', () => {
  it('save, reload, replace semantics, and expiry classification', async () => {
    const now = new Date();
    const s1: Suppression = {
      id: crypto.randomUUID(),
      fingerprint: 'fp-parity-1',
      resourceId: '/subscriptions/sub-1/resourceGroups/rg1/providers/p/t/one',
      reason: 'known noise',
      suppressedAt: now.toISOString(),
    };
    const s2: Suppression = {
      id: crypto.randomUUID(),
      fingerprint: 'fp-parity-2',
      reason: 'expired waiver',
      suppressedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() - DAY_MS).toISOString(),
    };
    await saveSuppressions([s1, s2]);

    const loaded = await loadSuppressions();
    const byId = (xs: Suppression[]) => [...xs].sort((x, y) => x.id.localeCompare(y.id));
    expect(byId(loaded)).toEqual(byId([s1, s2]));

    expect(isActiveSuppression(loaded.find(x => x.id === s1.id)!)).toBe(true);
    expect(isActiveSuppression(loaded.find(x => x.id === s2.id)!)).toBe(false);

    // saveSuppressions replaces the whole set, so a dropped row really is gone.
    await saveSuppressions([s1]);
    expect((await loadSuppressions()).map(x => x.id)).toEqual([s1.id]);
  });
});
