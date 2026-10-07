import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join, resolve } from 'node:path';
import { dbReady, rawSqlite, pgDb } from '@/lib/db/client';
import { runSeeds } from '@/lib/db/migrate';
import { seedPg } from '@/lib/db/pg/seeds';
import { createUser } from '@/lib/db/users';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { run } from '@/lib/db/exec';
import { rules, ruleVersions } from '@/lib/db/tables';
import { createRule, loadRules, updateRule } from '@/lib/rules';
import { listAuditEntries } from '@/lib/db/audit';
import { countRows } from '../helpers/db';
import { getCategory } from '@/lib/db/categories';
import { getFindingEventCounts, listFindings } from '@/lib/db/findings';
import { getSnapshots } from '@/lib/db/snapshots';
import { createSchedule, listSchedules } from '@/lib/db/schedules';
import { addSuppression, loadSuppressions } from '@/lib/suppressions';
import { loadScanHistory } from '@/lib/scan-history';
import { runCategoryScan } from '@/lib/scan-runner';
import { argRow, fakeTenantContext } from '../helpers/fake-azure';
import { resetDb } from '../helpers/db';
import { catalogueOf, shippedRule } from '../helpers/catalogue';
import type { RuleVersionHistory } from '@/lib/types';
import type { ShippedCatalogue } from '@/lib/shipped-catalogue';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const { GET } = await import('@/app/api/rules/[id]/versions/route');
const { PUT } = await import('@/app/api/rules/[id]/version/route');
const ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const dataDir = join(resolve(__dirname, '..', '..'), 'data');
const params = { params: Promise.resolve({ id: ID }) };
const v1 = shippedRule();
const v2 = shippedRule({ version: '2.0.0', releaseNote: 'Changed the query.', definition: { rawKql: 'Resources | where name == "new" | project id' } });

async function seed(catalogue: ShippedCatalogue): Promise<void> {
  await dbReady;
  if (pgDb) await seedPg(pgDb, dataDir, { skipOwnerBootstrap: true, catalogue });
  else runSeeds(rawSqlite!, dataDir, { skipOwnerBootstrap: true, catalogue });
}

async function signIn(role: 'viewer' | 'editor' | 'admin'): Promise<void> {
  const result = await createUser({ email: `${role}@example.com`, role });
  if ('error' in result) throw new Error(result.error);
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  await run(db.delete(ruleVersions).where(eq(ruleVersions.ruleId, ID)));
  await run(db.delete(rules).where(eq(rules.id, ID)));
  await seed(catalogueOf(v1));
  await seed(catalogueOf(v2));
  await signIn('admin');
});

function switchRequest(version: unknown): Request {
  return new Request('http://localhost/api/rules/x/version', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version }),
  });
}

async function storedRule() {
  return (await loadRules()).find(r => r.id === ID)!;
}

describe('recorded Rule versions', () => {
  it('lists newest first with running, New, dates, release notes, definitions and retirement', async () => {
    const response = await GET(new Request('http://localhost/api/rules/x/versions'), params);
    expect(response.status).toBe(200);
    const history: RuleVersionHistory = await response.json();
    expect(history.versions).toEqual([
      expect.objectContaining({
        version: '2.0.0', releaseNote: 'Changed the query.', upstreamRef: null,
        isRunning: false, isNewer: true,
        date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        definition: v2.definition,
      }),
      expect.objectContaining({ version: '1.0.0', isRunning: true, isNewer: false }),
    ]);
    expect(history.retired).toBe(false);
    for (const version of history.versions) expect(version).not.toHaveProperty('isRetired');
    expect(history.currentDefinition).toEqual(v1.definition);
  });

  it('switches forward and back without starting a scan or changing admin settings, and audits field names only', async () => {
    await updateRule(ID, { tags: ['owned'], enabled: false });
    const before = await storedRule();
    const response = await PUT(switchRequest('2.0.0'), params);
    expect(response.status).toBe(200);
    expect(await storedRule()).toEqual({ ...before, version: '2.0.0', rawKql: v2.definition.rawKql });
    expect(await countRows('scans')).toBe(0);
    expect(await countRows('schedule_runs')).toBe(0);
    const [audit] = await listAuditEntries();
    expect(audit).toMatchObject({
      action: 'rule.version', entityId: ID,
      summary: 'Switched built-in rule "Test rule" from 1.0.0 to 2.0.0',
      details: { changed: ['rawKql'] },
    });
    expect(JSON.stringify(audit.details)).not.toContain('Resources');

    expect((await PUT(switchRequest('1.0.0'), params)).status).toBe(200);
    expect(await storedRule()).toEqual(before);
    const history: RuleVersionHistory = await (await GET(new Request('http://localhost/api/rules/x/versions'), params)).json();
    expect(history.versions.map(v => [v.version, v.isRunning, v.isNewer])).toEqual([
      ['2.0.0', false, true], ['1.0.0', true, false],
    ]);
  });

  it('keeps matched finding age, history and suppression, fixes dropped findings and opens new ones on the next scan, forward and back', async () => {
    const category = (await getCategory('security'))!;
    const ctx = fakeTenantContext({
      rows: query => query === v1.definition.rawKql
        ? [argRow({ name: 'kept' }), argRow({ name: 'dropped' })]
        : [argRow({ name: 'kept' }), argRow({ name: 'new' })],
    });
    await runCategoryScan(category, { ctx, ruleIds: [ID], now: new Date('2026-09-24T12:00:00Z') });
    const before = await listFindings();
    const kept = before.find(f => f.resourceName === 'kept')!;
    const suppression = {
      id: 'version-suppression', fingerprint: kept.fingerprint, resourceId: kept.resourceId,
      reason: 'Accepted', suppressedAt: '2026-09-24T12:00:00Z',
    };
    await addSuppression(suppression);
    await createSchedule({
      name: 'Version schedule', targetType: 'rules', targetValues: [ID],
      recurrenceType: 'daily', interval: 1, daysOfWeek: null, dayOfMonth: null,
      startAt: '2026-09-24T12:00:00Z', endType: 'never', endDate: null,
    });
    const schedules = await listSchedules();
    const history = await loadScanHistory('security');
    const lastRun = await storedRule();
    expect((await PUT(switchRequest('2.0.0'), params)).status).toBe(200);
    expect(await listFindings()).toEqual(before);
    expect(await loadScanHistory('security')).toEqual(history);
    expect(await listSchedules()).toEqual(schedules);
    expect(await storedRule()).toMatchObject({ lastRunStatus: lastRun.lastRunStatus, lastRunAt: lastRun.lastRunAt });

    const forward = await runCategoryScan(category, { ctx, ruleIds: [ID], now: new Date('2026-09-25T12:00:00Z') });
    expect(forward.summary.coverage).toBe('complete');
    expect(forward.newFindings.map(f => f.resourceName)).toEqual(['new']);
    const findings = await listFindings();
    expect(findings.find(f => f.resourceName === 'kept')).toMatchObject({
      fingerprint: kept.fingerprint, firstSeenAt: '2026-09-24T12:00:00.000Z', status: 'active', timesSeen: 2,
    });
    expect(findings.find(f => f.resourceName === 'dropped')).toMatchObject({ status: 'fixed', resolvedAt: '2026-09-25T12:00:00.000Z' });
    expect(findings.find(f => f.resourceName === 'new')).toMatchObject({ status: 'active', firstSeenAt: '2026-09-25T12:00:00.000Z' });
    expect(await loadSuppressions()).toEqual([suppression]);

    expect((await PUT(switchRequest('1.0.0'), params)).status).toBe(200);
    await runCategoryScan(category, { ctx, ruleIds: [ID], now: new Date('2026-09-26T12:00:00Z') });
    const back = await listFindings();
    expect(back.find(f => f.resourceName === 'kept')).toMatchObject({ fingerprint: kept.fingerprint, firstSeenAt: kept.firstSeenAt, timesSeen: 3 });
    expect(back.find(f => f.resourceName === 'dropped')).toMatchObject({ status: 'active', firstSeenAt: '2026-09-24T12:00:00.000Z' });
    expect(back.find(f => f.resourceName === 'new')?.status).toBe('fixed');
    expect(await loadSuppressions()).toEqual([suppression]);
    expect((await getFindingEventCounts({
      categories: ['security'], sinceDate: '2026-09-24',
    })).slice(0, 3)).toEqual([
      { date: '2026-09-24', created: 2, resolved: 0 },
      { date: '2026-09-25', created: 1, resolved: 1 },
      { date: '2026-09-26', created: 1, resolved: 1 },
    ]);
  });

  it('moves matched findings to the switched category and resolves dropped findings under their original category', async () => {
    const security = (await getCategory('security'))!;
    const compliance = (await getCategory('compliance'))!;
    await seed(catalogueOf(shippedRule({
      version: '3.0.0', definition: { ...v2.definition, category: 'compliance' },
    })));
    const ctx = fakeTenantContext({
      rows: query => query === v1.definition.rawKql
        ? [argRow({ name: 'kept' }), argRow({ name: 'dropped' })] : [argRow({ name: 'kept' })],
    });
    await runCategoryScan(security, { ctx, ruleIds: [ID], now: new Date('2026-09-24T12:00:00Z') });
    const kept = (await listFindings()).find(f => f.resourceName === 'kept')!;
    expect((await PUT(switchRequest('3.0.0'), params)).status).toBe(200);
    await runCategoryScan(compliance, { ctx, ruleIds: [ID], now: new Date('2026-09-25T12:00:00Z') });
    expect((await listFindings()).find(f => f.resourceName === 'kept')).toMatchObject({
      fingerprint: kept.fingerprint, firstSeenAt: kept.firstSeenAt, category: 'compliance', status: 'active',
    });
    expect((await listFindings()).find(f => f.resourceName === 'dropped')).toMatchObject({ category: 'security', status: 'fixed' });
    expect((await getSnapshots({ categories: ['security'] })).at(-1)?.activeFindings).toBe(0);
    expect((await getSnapshots({ categories: ['compliance'] })).at(-1)?.activeFindings).toBe(1);
    expect((await getFindingEventCounts({ categories: ['security'], sinceDate: '2026-09-24' })).slice(0, 2)).toEqual([
      { date: '2026-09-24', created: 2, resolved: 0 }, { date: '2026-09-25', created: 0, resolved: 1 },
    ]);
    expect((await PUT(switchRequest('1.0.0'), params)).status).toBe(200);
    await runCategoryScan(security, { ctx, ruleIds: [ID], now: new Date('2026-09-26T12:00:00Z') });
    expect((await listFindings()).find(f => f.resourceName === 'kept')).toMatchObject({
      fingerprint: kept.fingerprint, firstSeenAt: kept.firstSeenAt, category: 'security', status: 'active',
    });
  });

  it('lets every role list versions but refuses viewers and editors switching, without side effects', async () => {
    const before = await storedRule();
    for (const role of ['viewer', 'editor'] as const) {
      await signIn(role);
      const response = await GET(new Request('http://localhost/api/rules/x/versions'), params);
      expect(response.status).toBe(200);
      expect((await response.json()).versions).toHaveLength(2);
      expect((await PUT(switchRequest('2.0.0'), params)).status).toBe(403);
      expect(await storedRule()).toEqual(before);
    }
    expect(await listAuditEntries()).toEqual([]);
    mockAuth.mockResolvedValue(null);
    expect((await GET(new Request('http://localhost/api/rules/x/versions'), params)).status).toBe(401);
    expect((await PUT(switchRequest('2.0.0'), params)).status).toBe(401);
  });

  it('refuses a case-insensitive name clash naming the other rule, and leaves every row and audit entry untouched', async () => {
    await seed(catalogueOf(shippedRule({ version: '3.0.0', definition: { name: 'Taken NAME' } })));
    await createRule({ ...await storedRule(), id: 'other-rule', name: 'taken name', type: 'custom', version: undefined });
    const before = await loadRules();
    const response = await PUT(switchRequest('3.0.0'), params);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('"taken name"');
    expect(await loadRules()).toEqual(before);
    expect(await listAuditEntries()).toEqual([]);
  });

  it('returns 404 for unknown versions or rules and 400 for Custom rules and malformed input, without writing', async () => {
    const before = await storedRule();
    expect((await PUT(switchRequest('unseen'), params)).status).toBe(404);
    const missing = { params: Promise.resolve({ id: 'missing' }) };
    expect((await PUT(switchRequest('1.0.0'), missing)).status).toBe(404);
    expect((await GET(new Request('http://localhost/api/rules/missing/versions'), missing)).status).toBe(404);
    for (const version of [null, '', ' ', 3, {}, []]) {
      expect((await PUT(switchRequest(version), params)).status).toBe(400);
    }
    const malformed = new Request('http://localhost/api/rules/x/version', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{',
    });
    expect((await PUT(malformed, params)).status).toBe(400);
    expect(await storedRule()).toEqual(before);
    await updateRule(ID, { type: 'custom' });
    expect((await PUT(switchRequest('2.0.0'), params)).status).toBe(400);
    expect((await storedRule()).version).toBe('1.0.0');
    expect(await listAuditEntries()).toEqual([]);
  });

  it('applies all definition fields, clears absent backend queries, and restores them on rollback', async () => {
    const v3 = shippedRule({
      version: '3.0.0',
      definition: {
        name: 'Directory check', description: 'A different recommendation.', category: 'identity',
        severity: 'high', queryBackend: 'microsoft-graph', kind: 'state',
        rawKql: null, graphQuery: { path: 'users', filter: 'accountEnabled eq false' },
        resourceTypes: [], scope: { level: 'subscription' }, conditions: [],
        conditionGroups: null, projectColumns: null, visualQuery: null,
      },
    });
    await seed(catalogueOf(v3));
    expect((await PUT(switchRequest('3.0.0'), params)).status).toBe(200);
    const history: RuleVersionHistory = await (await GET(new Request('http://localhost/api/rules/x/versions'), params)).json();
    expect(history.currentDefinition).toEqual(v3.definition);
    expect(history.currentQuery).toBe('{\n  "path": "users",\n  "filter": "accountEnabled eq false"\n}');
    expect(history.versions.map(v => v.isNewer)).toEqual([false, false, false]);
    expect((await storedRule()).rawKql).toBeUndefined();
    expect((await PUT(switchRequest('1.0.0'), params)).status).toBe(200);
    expect((await storedRule()).graphQuery).toBeUndefined();
    expect((await storedRule()).rawKql).toBe(v1.definition.rawKql);
  });

  it('lists upstream dates and references and keeps Retired rules retired when switching back', async () => {
    await run(db.delete(ruleVersions).where(eq(ruleVersions.ruleId, ID)));
    await run(db.delete(rules).where(eq(rules.id, ID)));
    const aprl = shippedRule({
      pack: 'aprl-v2', versionScheme: 'upstream-commit-date',
      version: '2026-06-08T13:06:47Z', upstreamRef: 'old-commit',
    });
    await seed(catalogueOf(aprl));
    await seed(catalogueOf({ ...aprl, version: '2026-06-08T16:06:47Z', upstreamRef: 'new-commit', definition: v2.definition }));
    await seed(catalogueOf());
    const history: RuleVersionHistory = await (await GET(new Request('http://localhost/api/rules/x/versions'), params)).json();
    expect(history.versions.map(v => [v.date, v.upstreamRef, v.isNewer])).toEqual([
      ['2026-06-08T16:06:47Z', 'new-commit', true],
      ['2026-06-08T13:06:47Z', 'old-commit', false],
    ]);
    expect(history.retired).toBe(true);
    for (const version of history.versions) expect(version).not.toHaveProperty('isRetired');
    const retiredAt = (await storedRule()).retiredAt;
    expect(retiredAt).toBeTruthy();
    expect((await PUT(switchRequest('2026-06-08T16:06:47Z'), params)).status).toBe(200);
    expect((await PUT(switchRequest('2026-06-08T13:06:47Z'), params)).status).toBe(200);
    expect((await storedRule()).retiredAt).toBe(retiredAt);
  });

  it('audits commit-date version switches with readable dates instead of ISO timestamps, including versions on the same day', async () => {
    await run(db.delete(ruleVersions).where(eq(ruleVersions.ruleId, ID)));
    await run(db.delete(rules).where(eq(rules.id, ID)));
    const aprl = shippedRule({
      pack: 'aprl-v2', versionScheme: 'upstream-commit-date',
      version: '2026-06-08T13:06:47Z',
    });
    await seed(catalogueOf(aprl));
    await seed(catalogueOf({ ...aprl, version: '2026-07-01T13:06:47Z', definition: v2.definition }));
    await seed(catalogueOf({ ...aprl, version: '2026-07-01T16:06:47Z', definition: { ...v2.definition, severity: 'high' } }));

    expect((await PUT(switchRequest('2026-07-01T13:06:47Z'), params)).status).toBe(200);
    expect((await listAuditEntries())[0].summary).toBe('Switched built-in rule "Test rule" from 2026-06-08 to 2026-07-01');
    expect((await PUT(switchRequest('2026-07-01T16:06:47Z'), params)).status).toBe(200);
    expect((await PUT(switchRequest('2026-06-08T13:06:47Z'), params)).status).toBe(200);
    const entries = await listAuditEntries();
    expect(entries.map(entry => entry.summary)).toEqual(expect.arrayContaining([
      'Switched built-in rule "Test rule" from 2026-06-08 to 2026-07-01',
      'Switched built-in rule "Test rule" from 2026-07-01 to 2026-07-01',
      'Switched built-in rule "Test rule" from 2026-07-01 to 2026-06-08',
    ]));
    expect(entries).toHaveLength(3);
  });

  it('can switch back to Before versioning and previews generated KQL exactly as the next scan runs it', async () => {
    await run(db.delete(ruleVersions).where(eq(ruleVersions.ruleId, ID)));
    await updateRule(ID, {
      description: 'Stored recommendation.',
      rawKql: undefined, conditions: [{ field: 'name', operator: 'equals', value: 'old' }],
    });
    await run(db.update(rules).set({ version: null }).where(eq(rules.id, ID)));
    await seed(catalogueOf(v1));
    const history: RuleVersionHistory = await (await GET(new Request('http://localhost/api/rules/x/versions'), params)).json();
    expect(history.versions.map(v => [v.version, v.isRunning, v.isNewer])).toEqual([
      ['1.0.0', false, true], ['before-versioning', true, false],
    ]);
    const before = await storedRule();
    const ctx = fakeTenantContext({ rows: [argRow()] });
    await runCategoryScan((await getCategory('security'))!, { ctx, ruleIds: [ID] });
    expect(history.currentQuery).toBe(ctx.queries[0].kql);
    expect(history.versions[1].query).toBe(ctx.queries[0].kql);
    expect((await PUT(switchRequest('1.0.0'), params)).status).toBe(200);
    expect((await PUT(switchRequest('before-versioning'), params)).status).toBe(200);
    expect(await storedRule()).toMatchObject({
      version: 'before-versioning', description: before.description, conditions: before.conditions,
    });
    expect((await storedRule()).rawKql).toBeUndefined();
    expect((await listAuditEntries()).map(e => e.summary)).toEqual(expect.arrayContaining([
      'Switched built-in rule "Test rule" from Before versioning to 1.0.0',
      'Switched built-in rule "Test rule" from 1.0.0 to Before versioning',
    ]));
  });

  it('serializes a version rename with a concurrent create so only one can claim the name', async () => {
    await seed(catalogueOf(shippedRule({ version: '3.0.0', definition: { name: 'Concurrent name' } })));
    const [switched, created] = await Promise.all([
      PUT(switchRequest('3.0.0'), params),
      createRule({ ...await storedRule(), id: 'concurrent-rule', name: 'concurrent name', type: 'custom', version: undefined }),
    ]);
    expect([switched.status === 200, created.ok].filter(Boolean)).toHaveLength(1);
    expect((await loadRules()).filter(r => r.name.toLowerCase() === 'concurrent name')).toHaveLength(1);
    if (created.ok) {
      expect(switched.status).toBe(409);
      expect((await storedRule()).version).toBe('1.0.0');
    } else {
      expect(created.reason).toBe('name-taken');
      expect((await storedRule()).version).toBe('3.0.0');
    }
  });
});
