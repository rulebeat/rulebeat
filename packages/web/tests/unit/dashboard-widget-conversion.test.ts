/**
 * ADR 0015: a dashboard made by this release (the starter, the create route) is already in the new shape,
 * and a copy of a converted dashboard carries its record and widget ids, so the upgrade's planner finds
 * nothing to convert in either. Real repositories and database (SQLite, or Postgres when the suite runs on it);
 * the plan is the one migrate.ts and pg/bootstrap.ts run on every start.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDashboards, resetDb } from '../helpers/db';
import { db } from '@/lib/db/client';
import { many } from '@/lib/db/exec';
import { dashboards } from '@/lib/db/tables';
import { createDashboard, createStarterDashboard, duplicateDashboard, getDashboard, updateDashboard } from '@/lib/db/dashboards';
import { planFilterConversion } from '@/lib/db/filter-conversion';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { STARTER_DASHBOARD } from '@/lib/dashboard-templates';
import type { DashboardConfig, WidgetDef } from '@/lib/types';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const { POST: CREATE_DASHBOARD } = await import('@/app/api/dashboards/route');

/** The plan the upgrade would run over the dashboards as stored now. */
async function planNow() {
  const rows = await many(db.select({ id: dashboards.id, config: dashboards.config }).from(dashboards));
  return planFilterConversion({ dashboards: rows, savedViews: [], pairs: [], now: '2026-01-01T00:00:00.000Z' });
}

/** Runs the plan's dashboard updates the way the start-up step does, through the repository. */
async function convert(id: string): Promise<DashboardConfig> {
  const update = (await planNow()).statements.find(s => s.sql.startsWith('UPDATE dashboards') && s.params[1] === id);
  if (!update) throw new Error('nothing to convert');
  await updateDashboard(id, { config: JSON.parse(update.params[0]!) as DashboardConfig });
  return (await getDashboard(id))!.config;
}

const widget = (id: string, type: WidgetDef['type'], config: Record<string, unknown>): WidgetDef =>
  ({ id, type, title: id, x: 0, y: 0, w: 4, h: 3, config });

beforeEach(async () => {
  await resetDb();
  await clearDashboards();
  mockAuth.mockReset();
});

describe('the starter dashboard', () => {
  it('is created with a 7d window, a 30d override on Trend and New vs Fixed, and no category on Trend', async () => {
    const starter = await createStarterDashboard();

    const byId = Object.fromEntries(starter.config.widgets.map(w => [w.id, w]));
    expect(starter.config.dimensionFilters).toEqual({ window: { mode: 'relative', days: 7 } });
    expect(byId.w5!.dimensionFilters).toEqual({ window: { mode: 'relative', days: 30 } });
    expect(byId.w15!.dimensionFilters).toEqual({ window: { mode: 'relative', days: 30 } });
    expect(byId.w5!.config.category).toBeUndefined();
    expect(byId.w5!.config.period).toBeUndefined();
    expect(byId.w15!.config.period).toBeUndefined();
    expect(starter.config.filters).toBeUndefined();
    expect(starter.config.convertedFrom).toBeUndefined();
  });

  it('needs no conversion, in the template and as stored', async () => {
    await createStarterDashboard();

    expect((await planNow()).statements).toEqual([]);
    const legacyKeys = STARTER_DASHBOARD.config.widgets.flatMap(w => ['category', 'policyIds', 'period', 'windowDays'].filter(k => k in w.config));
    expect(legacyKeys).toEqual([]);
  });
});

describe('creating a dashboard', () => {
  async function signInAsEditor(): Promise<void> {
    const created = await createUser({ email: `editor-${Math.random().toString(36).slice(2)}@example.com`, role: 'editor' });
    if ('error' in created) throw new Error(created.error);
    await setPassword(created.user.id, 'irrelevant-hash', { mustChangePassword: false });
    mockAuth.mockResolvedValue({ user: { uid: created.user.id } });
  }
  const post = (payload: unknown) => CREATE_DASHBOARD(new Request('http://localhost/api/dashboards', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  }));

  it('writes the filters the bar sends as dimensions only, with no legacy value and no record', async () => {
    await signInAsEditor();

    const res = await post({ name: 'New', config: { widgets: [], filters: { categories: ['cost'], severities: ['high'] }, windowDays: 30 } });

    expect(res.status).toBe(201);
    const stored = (await getDashboard((await res.json()).id))!.config;
    expect(stored.dimensionFilters).toEqual({ category: ['cost'], severity: ['high'], window: { mode: 'relative', days: 30 } });
    expect(stored.filters).toBeUndefined();
    expect(stored.windowDays).toBeUndefined();
    expect(stored.convertedFrom).toBeUndefined();
    expect((await planNow()).statements).toEqual([]);
  });
});

describe('duplicating a converted dashboard', () => {
  async function converted(): Promise<{ id: string; config: DashboardConfig }> {
    const made = await createDashboard({
      name: 'Legacy',
      config: {
        widgets: [
          widget('t', 'trend', { category: 'cost', period: 'all' }),
          { ...widget('f', 'findings-table' as WidgetDef['type'], { limit: 5, policyIds: ['r1'] }) },
          widget('s', 'stat-card', { metric: 'new-findings', windowDays: 7 }),
        ],
        filters: { tags: ['framework:iso27001'] },
      },
    });
    if (!made.ok) throw new Error('could not create');
    return { id: made.dashboard.id, config: await convert(made.dashboard.id) };
  }

  it('copies the converted config with its record and widget ids, and the copy needs no conversion', async () => {
    const source = await converted();
    expect((await planNow()).statements).toEqual([]);

    const copy = await duplicateDashboard(source.id);

    expect(copy!.config).toEqual(source.config);
    expect(copy!.config.widgets.map(w => w.id)).toEqual(['t', 'f', 's']);
    expect(copy!.config.convertedFrom?.widgets).toEqual({
      t: { category: 'cost', period: 'all' }, f: { policyIds: ['r1'] }, s: { windowDays: 7 },
    });
    expect((await planNow()).statements).toEqual([]);
  });

  it('converted the source in the first place', async () => {
    const source = await converted();

    expect(source.config.widgets.map(w => w.dimensionFilters)).toEqual([
      { category: ['cost'], window: { mode: 'relative', days: 365 } },
      { rule: ['r1'] },
      { window: { mode: 'relative', days: 7 } },
    ]);
  });
});
