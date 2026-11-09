/**
 * Saving a dashboard's filters (ADR 0013): the saved filters change only through a revision-checked save
 * that merges back what the saver cannot see, refuses what would widen or store a value outside their
 * Access, and writes nothing else. Fixture: the dashboard saves Subscription {A, B} and Severity
 * critical; L holds B only; M holds A and B.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDashboard, deleteDashboard, getDashboard, updateDashboard, updateDashboardFilters } from '@/lib/db/dashboards';
import { saveDashboardFilters } from '@/lib/dashboard-filter-save';
import { buildAccess, type Access } from '@/lib/access-model';
import type { WidgetDef } from '@/lib/types';
import { resetDb } from '../helpers/db';
import { EVERYTHING_ACCESS } from '../helpers/access';

// Another save can land between the revision check and the write. `beforeWrite` runs at that moment.
let beforeWrite: (() => Promise<void>) | null = null;
vi.mock('@/lib/db/dashboards', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db/dashboards')>('@/lib/db/dashboards');
  return {
    ...actual,
    updateDashboardFilters: async (...args: Parameters<typeof actual.updateDashboardFilters>) => {
      const hook = beforeWrite;
      beforeWrite = null;
      if (hook) await hook();
      return actual.updateDashboardFilters(...args);
    },
  };
});

const SUB_A = '00000000-0000-0000-0000-00000000000a';
const SUB_B = '00000000-0000-0000-0000-00000000000b';
const holding = (...ids: string[]): Access => buildAccess(
  ids.map(id => ({ tenantId: 't', scope: { kind: 'subscription' as const, path: `/subscriptions/${id}` }, role: 'editor' as const })),
  'manual',
);
const L = holding(SUB_B);
const M = holding(SUB_A, SUB_B);

const widget = (id: string, config: Record<string, unknown> = {}): WidgetDef => ({ id, type: 'stat-card', title: id, x: 0, y: 0, w: 4, h: 4, config }) as WidgetDef;

let id: string;
beforeEach(async () => {
  await resetDb();
  beforeWrite = null;
  const created = await createDashboard({
    name: `filters ${crypto.randomUUID()}`,
    config: {
      widgets: [widget('a', { severities: ['low'] })],
      autoRefresh: 60,
      filters: { subscriptions: [SUB_A, SUB_B], severities: ['critical'] },
      dateWindow: { mode: 'relative', days: 30 },
    },
  });
  if (!created.ok) throw new Error(created.reason);
  id = created.dashboard.id;
});

const revision = async () => (await getDashboard(id))!.revision;
const stored = async () => (await getDashboard(id))!.config;

describe('a save that is allowed', () => {
  it('writes the changed dimension, bumps the revision and names only the dimension', async () => {
    const before = await revision();
    const result = await saveDashboardFilters({ dashboardId: id, revision: before, changes: { severity: ['high'] }, access: EVERYTHING_ACCESS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toEqual(['severity']);
    expect(result.revision).toBe(before + 1);
    expect((await stored()).filters).toEqual({ subscriptions: [SUB_A, SUB_B], severities: ['high'] });
    expect(result.bar.revision).toBe(before + 1);
    expect(result.bar.dimensions.severity.changed).toBe(false);
  });

  it('saves the window, and any as an empty list, when nothing is held back', async () => {
    const result = await saveDashboardFilters({
      dashboardId: id, revision: await revision(), changes: { window: { mode: 'relative', days: 7 }, severity: [] }, access: EVERYTHING_ACCESS,
    });
    expect(result.ok && result.changed.sort()).toEqual(['severity', 'window']);
    const config = await stored();
    expect(config.dateWindow).toEqual({ mode: 'relative', days: 7 });
    expect(config.filters?.severities).toEqual([]);
  });

  it('leaves widget overrides, layout and the auto-refresh interval untouched', async () => {
    await saveDashboardFilters({ dashboardId: id, revision: await revision(), changes: { category: ['cost'] }, access: EVERYTHING_ACCESS });
    const config = await stored();
    expect(config.widgets).toEqual([widget('a', { severities: ['low'] })]);
    expect(config.autoRefresh).toBe(60);
  });

  it('merges back the subscription the saver cannot see when they narrow what they can', async () => {
    const SUB_C = '00000000-0000-0000-0000-00000000000c';
    const created = await createDashboard({
      name: `three ${crypto.randomUUID()}`,
      config: { widgets: [], filters: { subscriptions: [SUB_A, SUB_B, SUB_C] } },
    });
    if (!created.ok) throw new Error(created.reason);
    const result = await saveDashboardFilters({
      dashboardId: created.dashboard.id, revision: created.dashboard.revision, changes: { subscription: [SUB_C] }, access: holding(SUB_B, SUB_C),
    });
    expect(result.ok && result.changed).toEqual(['subscription']);
    const subs = (await getDashboard(created.dashboard.id))!.config.filters?.subscriptions;
    expect(new Set(subs)).toEqual(new Set([SUB_A, SUB_C]));
  });

  it('keeps M\'s subscriptions at {A, B} after L narrows another dimension and saves', async () => {
    const result = await saveDashboardFilters({ dashboardId: id, revision: await revision(), changes: { severity: ['high'] }, access: L });
    expect(result.ok && result.changed).toEqual(['severity']);
    expect(new Set((await stored()).filters?.subscriptions)).toEqual(new Set([SUB_A, SUB_B]));
  });

  it('writes nothing when the changes equal what is saved', async () => {
    const before = await revision();
    const result = await saveDashboardFilters({ dashboardId: id, revision: before, changes: { subscription: [SUB_B] }, access: L });
    expect(result.ok && result.changed).toEqual([]);
    expect(await revision()).toBe(before);
  });
});

describe('a save that is refused', () => {
  it('refuses L\'s save with A in the address and counts the values to remove', async () => {
    const before = await revision();
    const result = await saveDashboardFilters({ dashboardId: id, revision: before, changes: { subscription: [SUB_A, SUB_B] }, access: L });
    expect(result).toEqual({ ok: false, reason: 'outside-access', count: 1 });
    expect(await revision()).toBe(before);
  });

  it('refuses L\'s save of subscription= (any) over saved {A, B}', async () => {
    const before = await revision();
    const result = await saveDashboardFilters({ dashboardId: id, revision: before, changes: { subscription: [] }, access: L });
    expect(result).toEqual({ ok: false, reason: 'any-over-held-back', dimensions: ['subscription'] });
    expect(await revision()).toBe(before);
    expect((await stored()).filters?.subscriptions).toEqual([SUB_A, SUB_B]);
  });

  it('allows M, who holds both, to save any', async () => {
    const result = await saveDashboardFilters({ dashboardId: id, revision: await revision(), changes: { subscription: [] }, access: M });
    expect(result.ok).toBe(true);
  });

  it('answers a stale revision with the current one and writes nothing', async () => {
    const stale = await revision();
    await updateDashboard(id, { name: `renamed ${crypto.randomUUID()}` });
    const current = await revision();
    const result = await saveDashboardFilters({ dashboardId: id, revision: stale, changes: { severity: ['high'] }, access: EVERYTHING_ACCESS });
    expect(result).toMatchObject({ ok: false, reason: 'stale', revision: current });
    // The bar of the newer revision, with the person's changes still on it.
    expect(result.ok === false && result.reason === 'stale' && result.bar).toMatchObject({
      revision: current, dimensions: { severity: { effective: ['high'], saved: ['critical'], inUrl: true } },
    });
    expect((await stored()).filters?.severities).toEqual(['critical']);
    expect(await revision()).toBe(current);
  });

  it('answers a save that loses the race to the write as stale, with the bar of the revision that won', async () => {
    const opened = await revision();
    beforeWrite = async () => { await updateDashboardFilters(id, opened, { lists: { tags: ['prod'], severities: ['low'] } }); };
    const result = await saveDashboardFilters({ dashboardId: id, revision: opened, changes: { severity: ['high'] }, access: EVERYTHING_ACCESS });
    expect(result).toMatchObject({ ok: false, reason: 'stale', revision: opened + 1 });
    expect(result.ok === false && result.reason === 'stale' && result.bar).toMatchObject({
      revision: opened + 1,
      dimensions: { tags: { effective: ['prod'] }, severity: { effective: ['high'], saved: ['low'], inUrl: true } },
    });
    expect((await stored()).filters?.severities).toEqual(['low']);
  });

  it('answers a save whose dashboard was deleted before the write as not found', async () => {
    const opened = await revision();
    beforeWrite = async () => { await deleteDashboard(id); };
    expect(await saveDashboardFilters({ dashboardId: id, revision: opened, changes: { severity: ['high'] }, access: EVERYTHING_ACCESS }))
      .toEqual({ ok: false, reason: 'not-found' });
  });

  it('answers an unknown dashboard as not found', async () => {
    expect(await saveDashboardFilters({ dashboardId: 'nope', revision: 1, changes: {}, access: EVERYTHING_ACCESS })).toEqual({ ok: false, reason: 'not-found' });
  });
});
