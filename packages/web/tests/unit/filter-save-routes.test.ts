/**
 * The dashboard and saved view save routes and the Scope filter (ADR 0015, 0016): they write only the new
 * shape, leave the legacy values and the record of what they were converted from as the row held them, and
 * hold a person to the Scopes a save adds, never to those the row already held. Real `requireRole`, repositories
 * and database; only the session is mocked.
 *
 * Dashboard and view writes are install-wide (lib/rbac.ts), so only Everything reaches these routes today and
 * Everything holds every path. The held check is therefore also run on `prepareDashboardConfig` and
 * `prepareSavedViewQuery` with the Access of a person who holds one Scope, which is what a route passes it
 * the day a narrower Role may write.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execRaw, resetDb } from '../helpers/db';
import { SCOPE_RESOURCE_GROUP, SCOPE_SUBSCRIPTION, SUB_ONE, SUB_TWO } from '../helpers/access-matrix';
import { db } from '@/lib/db/client';
import { many } from '@/lib/db/exec';
import { scopeSets } from '@/lib/db/tables';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { createDashboard, getDashboard } from '@/lib/db/dashboards';
import { createScopeSet, expandScopeSet } from '@/lib/db/scope-sets';
import { createSavedView, getSavedView } from '@/lib/db/saved-views';
import { listAllAuditEntries } from '@/lib/db/audit';
import { buildAccess, parseScope, type Access } from '@/lib/access-model';
import { prepareDashboardConfig, prepareSavedViewQuery } from '@/lib/filter-save';
import type { DashboardConfig } from '@/lib/types';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const { POST: CREATE_DASHBOARD } = await import('@/app/api/dashboards/route');
const { PUT: UPDATE_DASHBOARD } = await import('@/app/api/dashboards/[id]/route');
const { POST: CREATE_VIEW } = await import('@/app/api/views/route');
const { PATCH: UPDATE_VIEW } = await import('@/app/api/views/[id]/route');

const TENANT = '00000000-0000-0000-0000-0000000000f0';
const SUB_TWO_PATH = `/subscriptions/${SUB_TWO}`;
const NOT_HELD = 'A path in the list is outside the Scopes you hold.';

const EVERYTHING = buildAccess([{ tenantId: TENANT, scope: parseScope('/')!, role: 'admin' as const }], 'manual');
const holding = (...paths: string[]): Access =>
  buildAccess(paths.map(path => ({ tenantId: TENANT, scope: parseScope(path)!, role: 'editor' as const })), 'manual');

/** Signs in an Editor who holds Everything. */
async function signInAsEditor(): Promise<void> {
  const created = await createUser({ email: `editor-${Math.random().toString(36).slice(2)}@example.com`, role: 'editor' });
  if ('error' in created) throw new Error(created.error);
  await setPassword(created.user.id, 'irrelevant-hash', { mustChangePassword: false });
  mockAuth.mockResolvedValue({ user: { uid: created.user.id } });
}

const json = (method: string, url: string, payload: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
const postDashboard = (payload: unknown) => CREATE_DASHBOARD(json('POST', '/api/dashboards', payload));
const putDashboard = (id: string, payload: unknown) => UPDATE_DASHBOARD(json('PUT', `/api/dashboards/${id}`, payload), { params: Promise.resolve({ id }) });
const postView = (payload: unknown) => CREATE_VIEW(json('POST', '/api/views', payload));
const patchView = (id: string, payload: unknown) => UPDATE_VIEW(json('PATCH', `/api/views/${id}`, payload), { params: Promise.resolve({ id }) });

const WIDGETS = [{ id: 'w1', type: 'stat-card', x: 0, y: 0, w: 3, h: 2, config: {} }] as DashboardConfig['widgets'];

let made = 0;
async function dashboardWith(config: Partial<DashboardConfig>): Promise<string> {
  const result = await createDashboard({ name: `Filtered ${made++}`, config: { widgets: WIDGETS, ...config } });
  if (!result.ok) throw new Error('could not create');
  return result.dashboard.id;
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

describe('saving a dashboard', () => {
  it('stores the dimensions it is sent and keeps the legacy values and their record as the row held them', async () => {
    await signInAsEditor();
    const legacy = { subscriptions: [SUB_ONE], tags: ['t'] };
    const id = await dashboardWith({
      filters: legacy, windowDays: 7, convertedFrom: { filters: legacy, windowDays: 7 },
      dimensionFilters: { scope: [SCOPE_SUBSCRIPTION], tags: ['t'] },
    });

    const res = await putDashboard(id, {
      config: {
        widgets: WIDGETS, autoRefresh: 30,
        // An old client writes the legacy shape: none of it is stored.
        filters: { subscriptions: [SUB_TWO] }, windowDays: 30, dateWindow: { mode: 'relative', days: 1 }, convertedFrom: {},
        dimensionFilters: { scope: [SUB_TWO_PATH], severity: ['high'] },
      },
    });

    expect(res.status).toBe(200);
    const stored = (await getDashboard(id))!.config;
    expect(stored.dimensionFilters).toEqual({ scope: [SUB_TWO_PATH], severity: ['high'] });
    expect(stored.filters).toEqual(legacy);
    expect(stored.windowDays).toBe(7);
    expect(stored.dateWindow).toBeUndefined();
    expect(stored.convertedFrom).toEqual({ filters: legacy, windowDays: 7 });
    expect(stored.autoRefresh).toBe(30);
  });

  it('converts a filter the bar sends as the old lists, so a change is stored and read back on reload', async () => {
    await signInAsEditor();
    await seedPair(SUB_ONE, 'rg-one');
    const legacy = { subscriptions: [SUB_TWO] };
    const id = await dashboardWith({
      filters: legacy, windowDays: 7, convertedFrom: { filters: legacy, windowDays: 7 }, dimensionFilters: { scope: [SUB_TWO_PATH] },
    });

    // The filter bar: the whole config, the old lists changed, and no dimensions.
    const res = await putDashboard(id, {
      config: {
        widgets: WIDGETS, filters: { subscriptions: [SUB_ONE], resourceGroups: ['rg-one'], severities: ['high'] },
        dateWindow: { mode: 'relative', days: 30 },
      },
    });

    expect(res.status).toBe(200);
    const stored = (await getDashboard(id))!.config;
    expect(stored.dimensionFilters).toEqual({
      scope: [`${SCOPE_SUBSCRIPTION}/resourceGroups/rg-one`], severity: ['high'], window: { mode: 'relative', days: 30 },
    });
    // What the dashboard reads and what a rollback reads is what the bar showed, and the upgrade has nothing to redo.
    expect(stored.filters).toEqual({ subscriptions: [SUB_ONE], resourceGroups: ['rg-one'], severities: ['high'] });
    expect(stored.dateWindow).toEqual({ mode: 'relative', days: 30 });
    expect(stored.windowDays).toBeUndefined();
    expect(stored.convertedFrom).toEqual({ filters: stored.filters, dateWindow: stored.dateWindow });
  });

  it('stores a filter bar list over the inline budget as a Scope set, never a refusal', async () => {
    await signInAsEditor();
    const subs = Array.from({ length: 40 }, (_, n) => `30000000-0000-0000-0000-${String(n).padStart(12, '0')}`);
    const wide = await dashboardWith({});
    const paired = await dashboardWith({});

    const bySubscription = await putDashboard(wide, { config: { widgets: WIDGETS, filters: { subscriptions: subs } } });
    const byGroup = await putDashboard(paired, { config: { widgets: WIDGETS, filters: { subscriptions: subs, resourceGroups: ['rg-wide'] } } });

    expect(bySubscription.status).toBe(200);
    expect(byGroup.status).toBe(200);
    const widePicks = (await getDashboard(wide))!.config.dimensionFilters!;
    expect(widePicks.scope).toBeUndefined();
    const expandedWide = await expandScopeSet(widePicks.scopeSet!);
    expect(expandedWide).toEqual({ status: 'resolved', paths: subs.map(s => `/subscriptions/${s}`) });
    const expandedPaired = await expandScopeSet((await getDashboard(paired))!.config.dimensionFilters!.scopeSet!);
    expect(expandedPaired).toEqual({ status: 'resolved', paths: subs.map(s => `/subscriptions/${s}/resourceGroups/rg-wide`) });
  });

  it('holds a long filter bar list to the Scopes the person holds, and creates no set for a refused list', async () => {
    const subs = Array.from({ length: 40 }, (_, n) => `30000000-0000-0000-0000-${String(n).padStart(12, '0')}`);
    const sent: DashboardConfig = { widgets: WIDGETS, filters: { subscriptions: subs } };

    const refused = await prepareDashboardConfig(holding(SCOPE_SUBSCRIPTION), sent, null);
    const allowed = await prepareDashboardConfig(EVERYTHING, sent, null);

    expect(refused).toEqual({ ok: false, error: NOT_HELD });
    expect(allowed.ok).toBe(true);
    expect(await many(db.select().from(scopeSets))).toHaveLength(1);
  });

  it('stores a cleared filter bar as no filters', async () => {
    await signInAsEditor();
    const legacy = { subscriptions: [SUB_TWO] };
    const id = await dashboardWith({
      filters: legacy, convertedFrom: { filters: legacy }, dimensionFilters: { scope: [SUB_TWO_PATH] },
    });

    await putDashboard(id, { config: { widgets: WIDGETS, filters: { subscriptions: [] }, dateWindow: { mode: 'relative', days: 7 } } });

    const stored = (await getDashboard(id))!.config;
    expect(stored.dimensionFilters).toEqual({ window: { mode: 'relative', days: 7 } });
    expect(stored.filters).toBeUndefined();
  });

  it('keeps the stored dimensions when the old lists it is sent are the ones the row holds', async () => {
    await signInAsEditor();
    const legacy = { subscriptions: [SUB_ONE] };
    const id = await dashboardWith({ filters: legacy, convertedFrom: { filters: legacy }, dimensionFilters: { scope: [SCOPE_SUBSCRIPTION], tags: ['t'] } });

    await putDashboard(id, { config: { widgets: [], filters: legacy } });

    expect((await getDashboard(id))!.config.dimensionFilters).toEqual({ scope: [SCOPE_SUBSCRIPTION], tags: ['t'] });
  });

  it('keeps the stored dimensions when a save only moves widgets', async () => {
    await signInAsEditor();
    const id = await dashboardWith({ dimensionFilters: { scope: [SCOPE_SUBSCRIPTION] } });

    await putDashboard(id, { config: { widgets: [], autoRefresh: 0 } });

    expect((await getDashboard(id))!.config.dimensionFilters).toEqual({ scope: [SCOPE_SUBSCRIPTION] });
  });

  it('creates a dashboard with the new shape only', async () => {
    await signInAsEditor();

    const res = await postDashboard({ name: 'New', config: { widgets: [], filters: { subscriptions: ['x'] }, dimensionFilters: { category: ['c'] } } });

    expect(res.status).toBe(201);
    const stored = (await getDashboard((await res.json()).id))!.config;
    expect(stored.dimensionFilters).toEqual({ category: ['c'] });
    expect(stored.filters).toBeUndefined();
  });

  it('refuses a Scope it adds that the person does not hold', async () => {
    const stored: DashboardConfig = { widgets: WIDGETS, dimensionFilters: { scope: [SCOPE_SUBSCRIPTION] } };

    const refused = await prepareDashboardConfig(holding(SCOPE_SUBSCRIPTION), { widgets: WIDGETS, dimensionFilters: { scope: [SCOPE_SUBSCRIPTION, SUB_TWO_PATH] } }, stored);

    expect(refused).toEqual({ ok: false, error: NOT_HELD });
  });

  it('asks only about the Scopes it adds: one the row already holds is kept by a person who does not hold it', async () => {
    const stored: DashboardConfig = { widgets: WIDGETS, dimensionFilters: { scope: [SUB_TWO_PATH, SCOPE_SUBSCRIPTION] } };

    const kept = await prepareDashboardConfig(holding(SCOPE_SUBSCRIPTION), {
      widgets: WIDGETS, dimensionFilters: { scope: [SUB_TWO_PATH.toUpperCase(), SCOPE_SUBSCRIPTION], severity: ['low'] },
    }, stored);

    expect(kept.ok && kept.value.dimensionFilters!.severity).toEqual(['low']);
  });

  it('checks the paths of a Scope set it names, and lets a set the row already holds stay', async () => {
    const outside = await createScopeSet([SCOPE_RESOURCE_GROUP, SUB_TWO_PATH]);
    const held = await createScopeSet([SCOPE_RESOURCE_GROUP]);
    const stored: DashboardConfig = { widgets: WIDGETS, dimensionFilters: { scopeSet: outside.hash } };
    const access = holding(SCOPE_RESOURCE_GROUP);

    expect((await prepareDashboardConfig(access, { widgets: WIDGETS, dimensionFilters: { scopeSet: outside.hash, tags: ['t'] } }, stored)).ok).toBe(true);
    expect((await prepareDashboardConfig(access, { widgets: WIDGETS, dimensionFilters: { scopeSet: held.hash } }, stored)).ok).toBe(true);
    expect(await prepareDashboardConfig(access, { widgets: WIDGETS, dimensionFilters: { scopeSet: outside.hash } }, null)).toEqual({ ok: false, error: NOT_HELD });
  });

  it('refuses a Scope set this install has no row for, and a pick that is no Scope', async () => {
    await signInAsEditor();
    const id = await dashboardWith({});

    expect((await putDashboard(id, { config: { widgets: [], dimensionFilters: { scopeSet: 'a'.repeat(64) } } })).status).toBe(400);
    expect((await putDashboard(id, { config: { widgets: [], dimensionFilters: { scope: ['/subscriptions/x/resourceGroups/y/providers/a/b/c'] } } })).status).toBe(400);
    expect((await putDashboard(id, { config: { widgets: [], dimensionFilters: { scope: ['/'] } } })).status).toBe(400);
  });

  it('keeps a Scope set whose row is gone when the save does not change it', async () => {
    const gone = 'c'.repeat(64);

    const kept = await prepareDashboardConfig(holding(SCOPE_SUBSCRIPTION), { widgets: WIDGETS, dimensionFilters: { scopeSet: gone, tags: ['t'] } },
      { widgets: WIDGETS, dimensionFilters: { scopeSet: gone } });

    expect(kept.ok && kept.value.dimensionFilters).toEqual({ scopeSet: gone, tags: ['t'] });
  });

  it('writes no audit entry for the filters', async () => {
    await signInAsEditor();
    const id = await dashboardWith({});

    await putDashboard(id, { config: { widgets: [], dimensionFilters: { scope: [SCOPE_SUBSCRIPTION] } } });

    expect(await listAllAuditEntries()).toEqual([]);
  });
});

describe('saving a view', () => {
  it('turns the subscription and resource group of a query into Scope picks and writes no legacy param', async () => {
    await signInAsEditor();
    await seedPair(SUB_ONE, 'rg-one');
    await seedPair(SUB_TWO, 'RG-One');

    const res = await postView({ name: 'Legacy', tab: 'results', query: `severity=high&rg=rg-one&subscription=${SUB_TWO}` });

    expect(res.status).toBe(201);
    const params = new URLSearchParams((await res.json()).query);
    expect(params.get('scope')).toBe(`${SUB_TWO_PATH}/resourceGroups/rg-one`);
    expect(params.has('subscription')).toBe(false);
    expect(params.has('rg')).toBe(false);
    expect(params.get('severity')).toBe('high');
  });

  it('stores a name-only group found in many subscriptions as a Scope set', async () => {
    await signInAsEditor();
    for (let n = 0; n < 40; n++) await seedPair(`30000000-0000-0000-0000-${String(n).padStart(12, '0')}`, 'rg-wide');

    const res = await postView({ name: 'Wide', tab: 'results', query: 'rg=rg-wide' });

    const stored = new URLSearchParams((await res.json()).query);
    expect(res.status).toBe(201);
    expect(stored.has('scope')).toBe(false);
    expect(stored.get('scopeset')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores a query near the limit with a short Scope list as a Scope set instead of refusing it', async () => {
    await signInAsEditor();
    for (let n = 0; n < 15; n++) await seedPair(`30000000-0000-0000-0000-${String(n).padStart(12, '0')}`, 'a');
    const query = `q=${'x'.repeat(2900)}&rg=a`;

    const res = await postView({ name: 'Near the limit', tab: 'results', query });

    expect(res.status).toBe(201);
    const stored = new URLSearchParams((await res.json()).query);
    expect(stored.get('q')).toBe('x'.repeat(2900));
    expect(stored.has('scope')).toBe(false);
    const expanded = await expandScopeSet(stored.get('scopeset')!);
    expect(expanded.status === 'resolved' && expanded.paths).toHaveLength(15);
  });

  it('refuses a Scope it adds that the person does not hold', async () => {
    const refused = await prepareSavedViewQuery(holding(SCOPE_SUBSCRIPTION), `scope=${encodeURIComponent(SUB_TWO_PATH)}`, null);

    expect(refused).toEqual({ ok: false, error: NOT_HELD });
  });

  it('asks only about the Scopes an update adds', async () => {
    const both = `scope=${encodeURIComponent(`${SUB_TWO_PATH},${SCOPE_SUBSCRIPTION}`)}`;
    const access = holding(SCOPE_SUBSCRIPTION);

    expect((await prepareSavedViewQuery(access, `severity=low&${both}`, both)).ok).toBe(true);
    expect(await prepareSavedViewQuery(access, `scope=${encodeURIComponent(`${SUB_TWO_PATH},${SCOPE_SUBSCRIPTION},/subscriptions/${SUB_TWO}/resourceGroups/x`)}`, both))
      .toEqual({ ok: false, error: NOT_HELD });
  });

  it('refuses a Scope set the person does not hold, one this install has no row for, and keeps one the view already names', async () => {
    const outside = await createScopeSet([SCOPE_RESOURCE_GROUP, SUB_TWO_PATH]);
    const access = holding(SCOPE_RESOURCE_GROUP);

    expect((await prepareSavedViewQuery(access, `severity=low&scopeset=${outside.hash}`, `scopeset=${outside.hash}`)).ok).toBe(true);
    expect(await prepareSavedViewQuery(access, `scopeset=${outside.hash}`, null)).toEqual({ ok: false, error: NOT_HELD });
    expect((await prepareSavedViewQuery(access, `scopeset=${'b'.repeat(64)}`, null)).ok).toBe(false);
  });

  it('keeps a name-only group as unresolved picks in a Scope set when there are too many to write inline, never as no Scope', async () => {
    const names = Array.from({ length: 80 }, (_, n) => `rg-missing-${String(n).padStart(3, '0')}`);

    const prepared = await prepareSavedViewQuery(EVERYTHING, `severity=high&rg=${names.join('%2C')}`, null);

    if (!prepared.ok) throw new Error(prepared.error);
    const params = new URLSearchParams(prepared.value);
    expect(params.get('severity')).toBe('high');
    expect(params.has('rg')).toBe(false);
    const expanded = await expandScopeSet(params.get('scopeset')!);
    expect(expanded).toEqual({ status: 'resolved', paths: names.map(n => `unresolved:resourceGroup/${n}`) });
  });

  it('keeps an unresolved pick beside the paths of a Scope set', async () => {
    for (let n = 0; n < 60; n++) await seedPair(`30000000-0000-0000-0000-${String(n).padStart(12, '0')}`, 'rg-wide');

    const prepared = await prepareSavedViewQuery(EVERYTHING, 'rg=rg-wide%2Crg-gone', null);

    if (!prepared.ok) throw new Error(prepared.error);
    const expanded = await expandScopeSet(new URLSearchParams(prepared.value).get('scopeset')!);
    expect(expanded.status === 'resolved' && expanded.paths).toHaveLength(61);
    expect(expanded.status === 'resolved' && expanded.paths).toContain('unresolved:resourceGroup/rg-gone');
  });

  it('reads the pairs on record only inside the Scopes the person holds', async () => {
    await seedPair(SUB_ONE, 'rg-shared');
    await seedPair(SUB_TWO, 'rg-shared');

    const prepared = await prepareSavedViewQuery(holding(SCOPE_SUBSCRIPTION), 'rg=rg-shared', null);

    expect(prepared.ok && new URLSearchParams(prepared.value).get('scope')).toBe(`${SCOPE_SUBSCRIPTION}/resourceGroups/rg-shared`);
    const none = await prepareSavedViewQuery(holding(SCOPE_RESOURCE_GROUP), 'rg=rg-shared', null);
    expect(none.ok && new URLSearchParams(none.value).get('scope')).toBe('unresolved:resourceGroup/rg-shared');
  });
});

describe('updating a saved view', () => {
  async function storedView(query: string): Promise<string> {
    const created = await createSavedView({ name: `View ${made++}`, tab: 'results', query }, null);
    if (!created.ok) throw new Error('could not create');
    return created.view.id;
  }

  it('turns the subscription and resource group of the new query into Scope picks and writes no legacy param', async () => {
    await signInAsEditor();
    await seedPair(SUB_ONE, 'rg-one');
    const id = await storedView('severity=low');

    const res = await patchView(id, { query: `severity=high&rg=rg-one&subscription=${SUB_ONE}` });

    expect(res.status).toBe(200);
    const params = new URLSearchParams((await getSavedView(id))!.query);
    expect(params.get('scope')).toBe(`${SCOPE_SUBSCRIPTION}/resourceGroups/rg-one`);
    expect(params.has('subscription')).toBe(false);
    expect(params.has('rg')).toBe(false);
    expect(params.get('severity')).toBe('high');
  });

  it('writes no legacy param when a query already holds a Scope beside them, as a view the upgrade converted does', async () => {
    await signInAsEditor();
    const scope = `scope=${encodeURIComponent(SCOPE_SUBSCRIPTION)}`;
    const upgraded = `severity=high&subscription=${SUB_ONE}&rg=rg-one&${scope}`;
    const id = await storedView(upgraded);

    // The explorer sends back every param it was opened with.
    expect((await patchView(id, { query: `severity=low&subscription=${SUB_ONE}&rg=rg-one&${scope}` })).status).toBe(200);
    const patched = new URLSearchParams((await getSavedView(id))!.query);
    expect(patched.get('scope')).toBe(SCOPE_SUBSCRIPTION);
    expect(patched.get('severity')).toBe('low');
    expect(patched.has('subscription')).toBe(false);
    expect(patched.has('rg')).toBe(false);

    const created = await postView({ name: 'Copy', tab: 'results', query: upgraded });
    const posted = new URLSearchParams((await created.json()).query);
    expect(created.status).toBe(201);
    expect(posted.get('scope')).toBe(SCOPE_SUBSCRIPTION);
    expect(posted.has('subscription')).toBe(false);
    expect(posted.has('rg')).toBe(false);
  });

  it('writes no legacy param beside a Scope set either', async () => {
    const set = await createScopeSet([SCOPE_SUBSCRIPTION]);

    const prepared = await prepareSavedViewQuery(EVERYTHING, `rg=rg-one&scopeset=${set.hash}`, null);

    expect(prepared.ok && new URLSearchParams(prepared.value).has('rg')).toBe(false);
    expect(prepared.ok && new URLSearchParams(prepared.value).get('scopeset')).toBe(set.hash);
  });

  it('keeps a name no record pairs as an unresolved pick, and a long one in a Scope set', async () => {
    await signInAsEditor();
    const id = await storedView('severity=low');
    const names = Array.from({ length: 80 }, (_, n) => `rg-missing-${String(n).padStart(3, '0')}`);

    expect((await patchView(id, { query: 'rg=rg-gone' })).status).toBe(200);
    expect(new URLSearchParams((await getSavedView(id))!.query).get('scope')).toBe('unresolved:resourceGroup/rg-gone');

    expect((await patchView(id, { query: `rg=${names.join('%2C')}` })).status).toBe(200);
    expect(new URLSearchParams((await getSavedView(id))!.query).get('scopeset')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('answers 404 for a view that is not there, and leaves a rename alone without reading its query', async () => {
    await signInAsEditor();
    const id = await storedView('rg=rg-kept');

    expect((await patchView('missing-id', { query: 'severity=high' })).status).toBe(404);
    expect((await patchView(id, { name: 'Renamed' })).status).toBe(200);
    expect((await getSavedView(id))!.query).toBe('rg=rg-kept');
  });
});

/** One finding in `subscription` and `group`, so the pair is on record. */
let pairs = 0;
async function seedPair(subscription: string, group: string): Promise<void> {
  await execRaw(`
    INSERT INTO findings (fingerprint, rule_id, category, severity, subscription_id, resource_group, title, first_seen_at, last_seen_at)
    VALUES ('route-fp-${pairs++}', 'pair-rule', 'security', 'high', '${subscription}', '${group}', 'A finding', '2026-01-02T03:04:05.000Z', '2026-02-03T04:05:06.000Z')`);
}

describe('what a save adds is held to the shape and cap of a Scope set (ADR 0016)', () => {
  const subs = (n: number) => Array.from({ length: n }, (_, i) => `30000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
  const subscriptionPaths = (n: number) => subs(n).map(s => `/subscriptions/${s}`);

  it('refuses a dashboard Scope list over 2000 paths and text that is no Scope, and keeps an unresolved pick the row holds', async () => {
    await signInAsEditor();
    const id = await dashboardWith({});

    const tooMany = await putDashboard(id, { config: { widgets: WIDGETS, dimensionFilters: { scope: subscriptionPaths(2501) } } });
    const text = await putDashboard(id, { config: { widgets: WIDGETS, dimensionFilters: { scope: ['unresolved:anything at all'] } } });

    expect(tooMany.status).toBe(400);
    expect(text.status).toBe(400);
    const stored: DashboardConfig = { widgets: WIDGETS, dimensionFilters: { scope: ['unresolved:resourceGroup/rg-gone'] } };
    const kept = await prepareDashboardConfig(holding(SCOPE_SUBSCRIPTION), { widgets: WIDGETS, dimensionFilters: { scope: ['unresolved:resourceGroup/rg-gone'], tags: ['t'] } }, stored);
    expect(kept.ok).toBe(true);
  });

  it('counts only the Scopes a dashboard save adds against the cap', async () => {
    const stored: DashboardConfig = { widgets: WIDGETS, dimensionFilters: { scope: subscriptionPaths(2500) } };

    const kept = await prepareDashboardConfig(EVERYTHING, { widgets: WIDGETS, dimensionFilters: { scope: subscriptionPaths(2500), tags: ['t'] } }, stored);

    expect(kept.ok).toBe(true);
  });

  it('refuses a filter bar list whose cross product is over 2000 paths and creates no set for it', async () => {
    const lists = { subscriptions: subs(30), resourceGroups: Array.from({ length: 100 }, (_, i) => `rg-${i}`) };

    const refused = await prepareDashboardConfig(EVERYTHING, { widgets: WIDGETS, filters: lists }, null);

    expect(refused.ok).toBe(false);
    expect(await many(db.select().from(scopeSets))).toHaveLength(0);
  });

  it('refuses a saved view whose subscription and resource group params cross to over 2000 paths, with no set left behind', async () => {
    await signInAsEditor();
    const names = Array.from({ length: 100 }, (_, i) => `rg-${i}`);

    const res = await postView({ name: 'Wide cross', tab: 'results', query: `subscription=${subs(30).join('%2C')}&rg=${names.join('%2C')}` });

    expect(res.status).toBe(400);
    expect(await many(db.select().from(scopeSets))).toHaveLength(0);
  });

  it('refuses a saved view Scope list over 2000 paths and text that is no Scope', async () => {
    const wide = `scope=${encodeURIComponent(subscriptionPaths(2001).join(','))}`;

    expect((await prepareSavedViewQuery(EVERYTHING, wide, null)).ok).toBe(false);
    expect((await prepareSavedViewQuery(EVERYTHING, 'scope=unresolved%3Aanything', null)).ok).toBe(false);
    expect((await prepareSavedViewQuery(EVERYTHING, 'scope=unresolved%3Aanything', 'scope=unresolved%3Aanything')).ok).toBe(true);
  });

  it('leaves no set behind when a saved view save is refused as not held', async () => {
    const refused = await prepareSavedViewQuery(holding(SCOPE_SUBSCRIPTION), `subscription=${subs(40).join('%2C')}`, null);

    expect(refused).toEqual({ ok: false, error: NOT_HELD });
    expect(await many(db.select().from(scopeSets))).toHaveLength(0);
  });
});
