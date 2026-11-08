/**
 * #379: a write that changes a rule's category rewrites `findings.category` for all of that rule's
 * findings, open and fixed, in the same transaction, and refreshes both categories' daily snapshots.
 * The live numbers (ring, Scans count, New vs Fixed) count the findings under the new category at once,
 * without a rescan. `scan_findings.category` and the stored scan blobs are not touched, so Run History
 * and Compare keep showing what each scan saw. The event counts follow the rule's current category
 * through a read-time join and fall back to the stored event category when the rule row is gone.
 *
 * Runs the writes on whichever backend tests/setup.ts selected. The seeding writes go through the
 * backend's own seeder (`runSeeds` or `seedPg`).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { join, resolve } from 'node:path';
import { getCategory } from '@/lib/db/categories';
import { db, dbReady, pgDb, rawSqlite, recordCategoriesMovedBySeeding } from '@/lib/db/client';
import { many as execMany, run as execRun } from '@/lib/db/exec';
import { rules as rulesTable, ruleVersions, scanFindings as scanFindingsTable } from '@/lib/db/tables';
import { runSeeds } from '@/lib/db/migrate';
import { seedPg } from '@/lib/db/pg/seeds';
import { getActivityOccurrenceCounts, getFindingEventCounts, listFindings, refreshSnapshotsForSeededMoves, syncScanFindings } from '@/lib/db/findings';
import { computeActivityFingerprint } from '@rulebeat/core';
import type { Finding } from '@/lib/types';
import { queryView } from '@/lib/db/finding-views';
import { querySnapshot } from '@/lib/db/scan-snapshots';
import { listScanMetas } from '@/lib/scan-history';
import { emptySnapshotQuery } from '@/lib/snapshot-query';
import { getSnapshots, upsertDailySnapshot } from '@/lib/db/snapshots';
import { approveLibraryRequest, createLibraryRequest } from '@/lib/db/library-requests';
import { createPersonalRule } from '@/lib/db/personal-rules';
import { createUser } from '@/lib/db/users';
import { computeWidgetSummary } from '@/lib/dashboard-data';
import { emptyView, type View } from '@/lib/finding-view';
import { deleteRule, loadRules, switchRuleVersion, updateRule } from '@/lib/rules';
import { runCategoryScan } from '@/lib/scan-runner';
import { resetDb } from '../helpers/db';
import { catalogueOf, shippedRule } from '../helpers/catalogue';
import { fakeTenantContext, argRow, TEST_SUB_A } from '../helpers/fake-azure';
import { EVERYTHING_ACCESS } from '../helpers/access';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';
import type { ShippedCatalogue } from '@/lib/shipped-catalogue';

const RULE_ID = 'move-rule';
const BUILTIN_ID = 'aaaaaaaa-0000-4000-8000-0000000000d1';
const WINDOW = { mode: 'relative', days: 7 } as const;
const dataDir = join(resolve(__dirname, '..', '..'), 'data');
const since = () => new Date(Date.now() - 7 * 86_400_000).toISOString();

/** Seeds `catalogue` through the active backend's seeder; returns the categories it moved findings between. */
async function seed(catalogue: ShippedCatalogue): Promise<string[]> {
  await dbReady;
  const moved = pgDb
    ? await seedPg(pgDb, dataDir, { skipOwnerBootstrap: true, catalogue })
    : runSeeds(rawSqlite!, dataDir, { skipOwnerBootstrap: true, catalogue });
  return [...moved].sort();
}

const categoryView = (category: string): View => ({ ...emptyView(), filters: [{ field: 'category', values: [category] }] });
const results = { tab: 'results', showSuppressed: false } as const;

async function insertRule(id: string, category = 'security'): Promise<void> {
  await execRun(db.delete(rulesTable).where(eq(rulesTable.id, id)));
  await execRun(db.insert(rulesTable).values({
    id, name: id, description: 'test rule', category, severity: 'medium', enabled: true,
    scope: JSON.stringify({ level: 'subscription' }), resourceTypes: JSON.stringify([]), conditions: JSON.stringify([]),
    rawKql: 'resources | where type == "microsoft.compute/virtualmachines"', type: 'custom',
  }));
}

/** Two findings from a scan of security, then a rescan that no longer returns vm-2: one open, one fixed. */
async function openAndFixed(): Promise<void> {
  const security = (await getCategory('security'))!;
  const scan = (rows: ReturnType<typeof argRow>[]) => runCategoryScan(security, {
    access: EVERYTHING_ACCESS, ctx: fakeTenantContext({ rows }), ruleIds: [RULE_ID],
  });
  await scan([argRow({ name: 'vm-1' }), argRow({ name: 'vm-2' })]);
  await scan([argRow({ name: 'vm-1' })]);
}

const categoriesOf = async () => Object.fromEntries(
  (await listFindings(EVERYTHING_ACCESS)).filter(f => f.ruleId === RULE_ID).map(f => [f.resourceName, f.category]),
);
const activeIn = async (category: string) =>
  (await computeWidgetSummary({ dateWindow: WINDOW, categories: [category] }, 30, EVERYTHING_ACCESS)).current.activeFindings;
const snapshotActive = async (category: string) =>
  (await getSnapshots(EVERYTHING_ACCESS, { categories: [category] }))[0]?.activeFindings;
const createdIn = async (category: string) =>
  (await getFindingEventCounts({ categories: [category], sinceDate: since() }, EVERYTHING_ACCESS))
    .reduce((n, c) => n + c.created, 0);
const resolvedIn = async (category: string) =>
  (await getFindingEventCounts({ categories: [category], sinceDate: since() }, EVERYTHING_ACCESS))
    .reduce((n, c) => n + c.resolved, 0);

beforeEach(async () => {
  await resetDb();
  await insertRule(RULE_ID);
});

describe('a custom rule edit that changes the category', () => {
  beforeEach(async () => {
    await openAndFixed();
    expect(await activeIn('security')).toBe(1);
    expect(await snapshotActive('security')).toBe(1);
  });

  it('moves its open and its fixed findings at once, with no rescan', async () => {
    expect(await updateRule(RULE_ID, { category: 'compliance' })).toMatchObject({ ok: true });
    expect(await categoriesOf()).toEqual({ 'vm-1': 'compliance', 'vm-2': 'compliance' });
  });

  it('counts the open finding under the new category in the ring and in Scans', async () => {
    await updateRule(RULE_ID, { category: 'compliance' });
    expect(await activeIn('compliance')).toBe(1);
    expect(await activeIn('security')).toBe(0);
    expect((await queryView(categoryView('compliance'), results, EVERYTHING_ACCESS)).total).toBe(1);
    expect((await queryView(categoryView('security'), results, EVERYTHING_ACCESS)).total).toBe(0);
  });

  it('counts the rule\'s events under the new category in New vs Fixed', async () => {
    await updateRule(RULE_ID, { category: 'compliance' });
    expect(await createdIn('compliance')).toBe(2);
    expect(await resolvedIn('compliance')).toBe(1);
    expect(await createdIn('security')).toBe(0);
    expect(await resolvedIn('security')).toBe(0);
  });

  it('refreshes both categories\' snapshots', async () => {
    await updateRule(RULE_ID, { category: 'compliance' });
    expect(await snapshotActive('security')).toBe(0);
    expect(await snapshotActive('compliance')).toBe(1);
  });

  it('leaves Run History and Compare showing the category each scan saw', async () => {
    await updateRule(RULE_ID, { category: 'compliance' });
    const stored = await execMany(db.select({ category: scanFindingsTable.category }).from(scanFindingsTable));
    expect(stored.length).toBeGreaterThan(0);
    expect(new Set(stored.map(r => r.category))).toEqual(new Set(['security']));
    // Each scan is still a scan of security, with the findings it recorded.
    const metas = await listScanMetas('security', EVERYTHING_ACCESS);
    expect(metas).toHaveLength(2);
    expect(await listScanMetas('compliance', EVERYTHING_ACCESS)).toHaveLength(0);
    const earlier = await querySnapshot(metas[metas.length - 1]!.id, emptySnapshotQuery(), EVERYTHING_ACCESS);
    expect(earlier).toMatchObject({ status: 'ok', response: { total: 2 } });
  });

  it('touches nothing when the edit leaves the category alone', async () => {
    await updateRule(RULE_ID, { severity: 'high' });
    expect(await categoriesOf()).toEqual({ 'vm-1': 'security', 'vm-2': 'security' });
  });

  it('does not move another rule\'s findings', async () => {
    await insertRule('stays-put');
    await storeScan([syntheticFinding('vm-x', [{ n: 1 }], { ruleId: 'stays-put' })], { scanId: 'stays-scan', finishedAt: new Date().toISOString() });
    await updateRule(RULE_ID, { category: 'compliance' });
    const other = (await listFindings(EVERYTHING_ACCESS)).find(f => f.ruleId === 'stays-put')!;
    expect(other.category).toBe('security');
  });
});

describe('a deleted rule', () => {
  it('keeps counting its events under their stored category', async () => {
    await storeScan(
      [syntheticFinding('vm-gone', [{ n: 1 }], { ruleId: 'gone-rule', category: 'security' })],
      { scanId: 'gone-scan', finishedAt: new Date().toISOString() },
    );
    // No rule row ever existed for it, which is what the join sees once a rule is deleted.
    expect(await createdIn('security')).toBe(1);
    expect(await createdIn('compliance')).toBe(0);
  });

  it('is removed with its events by deleteRule, as before', async () => {
    await openAndFixed();
    await deleteRule(RULE_ID);
    expect(await createdIn('security')).toBe(0);
  });
});

describe('a version switch that changes the category', () => {
  const v1 = shippedRule({ id: BUILTIN_ID, definition: { category: 'security' } });
  const v2 = shippedRule({
    id: BUILTIN_ID, version: '2.0.0', releaseNote: 'Moved.',
    definition: { category: 'compliance', rawKql: 'Resources | where name == "new" | project id' },
  });

  beforeEach(async () => {
    await execRun(db.delete(ruleVersions).where(eq(ruleVersions.ruleId, BUILTIN_ID)));
    await execRun(db.delete(rulesTable).where(eq(rulesTable.id, BUILTIN_ID)));
    await seed(catalogueOf(v1));
    await storeScan([
      syntheticFinding('vm-b1', [{ n: 1 }], { ruleId: BUILTIN_ID }),
      syntheticFinding('vm-b2', [{ n: 2 }], { ruleId: BUILTIN_ID }),
    ], { scanId: 'switch-scan-1', finishedAt: new Date(Date.now() - 2000).toISOString() });
    await storeScan([syntheticFinding('vm-b1', [{ n: 1 }], { ruleId: BUILTIN_ID })],
      { scanId: 'switch-scan-2', finishedAt: new Date(Date.now() - 1000).toISOString() });
    await seed(catalogueOf(v2));
  });

  const builtinFindings = async () => Object.fromEntries(
    (await listFindings(EVERYTHING_ACCESS)).filter(f => f.ruleId === BUILTIN_ID).map(f => [f.resourceName, f.category]),
  );

  it('moves the findings with the rule, and back again', async () => {
    expect(await builtinFindings()).toEqual({ 'vm-b1': 'security', 'vm-b2': 'security' });
    expect(await snapshotActive('security')).toBeUndefined();
    expect(await switchRuleVersion(BUILTIN_ID, '2.0.0')).toMatchObject({ ok: true });
    expect(await builtinFindings()).toEqual({ 'vm-b1': 'compliance', 'vm-b2': 'compliance' });
    expect(await activeIn('compliance')).toBe(1);
    expect(await snapshotActive('compliance')).toBe(1);
    expect(await snapshotActive('security')).toBe(0);

    expect(await switchRuleVersion(BUILTIN_ID, '1.0.0')).toMatchObject({ ok: true });
    expect(await builtinFindings()).toEqual({ 'vm-b1': 'security', 'vm-b2': 'security' });
    expect(await snapshotActive('compliance')).toBe(0);
  });
});

describe('startup seeding that changes the category', () => {
  const v1 = shippedRule({ id: BUILTIN_ID, definition: { category: 'security' } });
  const v2 = shippedRule({
    id: BUILTIN_ID, version: '2.0.0', releaseNote: 'Moved.',
    definition: { category: 'compliance', rawKql: 'Resources | where name == "new" | project id' },
  });

  const builtinCategories = async () => [...new Set(
    (await listFindings(EVERYTHING_ACCESS)).filter(f => f.ruleId === BUILTIN_ID).map(f => f.category),
  )];

  beforeEach(async () => {
    await execRun(db.delete(ruleVersions).where(eq(ruleVersions.ruleId, BUILTIN_ID)));
    await execRun(db.delete(rulesTable).where(eq(rulesTable.id, BUILTIN_ID)));
    await seed(catalogueOf(v1));
    await storeScan([syntheticFinding('vm-s1', [{ n: 1 }], { ruleId: BUILTIN_ID })],
      { scanId: 'seed-scan', finishedAt: new Date().toISOString() });
  });

  it('moves the findings of a disabled rule that moves to the new version', async () => {
    await updateRule(BUILTIN_ID, { enabled: false });
    // The seeder cannot recompute snapshots, so it names the categories for startup to refresh.
    expect(await seed(catalogueOf(v2))).toEqual(['compliance', 'security']);
    expect((await loadRules()).find(r => r.id === BUILTIN_ID)!.category).toBe('compliance');
    expect(await builtinCategories()).toEqual(['compliance']);
  });

  it('refreshes both categories\' snapshots at startup', async () => {
    await upsertDailySnapshot('security');
    expect(await snapshotActive('security')).toBe(1);
    await updateRule(BUILTIN_ID, { enabled: false });
    recordCategoriesMovedBySeeding(await seed(catalogueOf(v2)));
    await refreshSnapshotsForSeededMoves();
    expect(await snapshotActive('security')).toBe(0);
    expect(await snapshotActive('compliance')).toBe(1);
  });

  it('leaves the findings of an enabled rule, which keeps what it runs', async () => {
    expect(await seed(catalogueOf(v2))).toEqual([]);
    expect((await loadRules()).find(r => r.id === BUILTIN_ID)!.category).toBe('security');
    expect(await builtinCategories()).toEqual(['security']);
  });

  it('moves the findings of a built-in stored with no version, which takes the shipped definition', async () => {
    await execRun(db.update(rulesTable).set({ version: null }).where(eq(rulesTable.id, BUILTIN_ID)));
    expect(await seed(catalogueOf(v2))).toEqual(['compliance', 'security']);
    expect((await loadRules()).find(r => r.id === BUILTIN_ID)!.category).toBe('compliance');
    expect(await builtinCategories()).toEqual(['compliance']);
  });
});

describe('a Library request approval that changes the category', () => {
  it('moves the target rule\'s findings with it', async () => {
    await openAndFixed();
    const author = await createUser({ email: 'author@example.com', role: 'editor', access: [] });
    const reviewer = await createUser({ email: 'reviewer@example.com', role: 'admin', access: [] });
    if ('error' in author || 'error' in reviewer) throw new Error('could not create the people');
    const personal = await createPersonalRule(author.user.id, {
      name: 'Updated VM rule', description: 'Flags virtual machines', category: 'security', severity: 'medium',
      queryBackend: 'resource-graph', kind: 'state', tags: [], scope: { level: 'subscription', subscriptions: [TEST_SUB_A] },
      resourceTypes: [], conditions: [], rawKql: 'resources | where type == "microsoft.compute/virtualmachines"',
    });
    const request = await createLibraryRequest(personal, author.user.id, undefined, RULE_ID);
    if (!request.ok) throw new Error(request.reason);

    const approved = await approveLibraryRequest(request.request.id, reviewer.user.id, { category: 'compliance' });
    expect(approved).toMatchObject({ ok: true });
    expect(await categoriesOf()).toEqual({ 'vm-1': 'compliance', 'vm-2': 'compliance' });
    expect(await activeIn('compliance')).toBe(1);
    expect(await snapshotActive('security')).toBe(0);
    expect(await snapshotActive('compliance')).toBe(1);
  });
});

describe('Activity occurrences after a rule moves category', () => {
  const day = () => new Date().toISOString().slice(0, 10);
  const activityFinding = (): Finding => ({
    module: 'security', ruleId: RULE_ID, fingerprint: computeActivityFingerprint(RULE_ID, 'principal-a'),
    kind: 'activity', dimensionKey: 'principal-a', severity: 'medium', category: 'security',
    subscriptionId: 'sub-1', title: 'activity', description: 'test', evidence: {}, recommendation: 'investigate',
    remediationSteps: [], detectedAt: new Date().toISOString(),
  });
  const occurrencesIn = async (category: string) =>
    (await getActivityOccurrenceCounts({ categories: [category], sinceDate: day() }, EVERYTHING_ACCESS))
      .reduce((n, c) => n + c.count, 0);

  beforeEach(async () => {
    await syncScanFindings({
      scanId: 'activity-scan', category: 'security', ranRuleIds: [RULE_ID],
      findings: [activityFinding()], finishedAt: new Date().toISOString(),
    });
    expect(await occurrencesIn('security')).toBe(1);
  });

  it('counts the rule\'s occurrences under its new category, with no rescan', async () => {
    await updateRule(RULE_ID, { category: 'compliance' });
    expect(await occurrencesIn('compliance')).toBe(1);
    expect(await occurrencesIn('security')).toBe(0);
  });

  it('keeps counting them under the stored category once the rule row is gone', async () => {
    await execRun(db.delete(rulesTable).where(eq(rulesTable.id, RULE_ID)));
    expect(await occurrencesIn('security')).toBe(1);
    expect(await occurrencesIn('compliance')).toBe(0);
  });
});
