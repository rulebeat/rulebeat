/**
 * Issue #334: every dashboard and saved-view row carries an integer revision that every write
 * bumps, so a later save can tell it is writing over a row someone else changed. Runs against
 * whichever backend the suite is on; the writes go through the repositories the routes call.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { clearDashboards, resetDb } from '../helpers/db';
import {
  createDashboard, createStarterDashboard, deleteDashboard, duplicateDashboard, getDashboard,
  setDefaultDashboard, updateDashboard,
} from '@/lib/db/dashboards';
import { createSavedView, getSavedView, updateSavedView } from '@/lib/db/saved-views';
import type { Dashboard } from '@/lib/types';

const unique = (label: string) => `${label} ${Math.random().toString(36).slice(2)}`;

async function dashboardNamed(name: string): Promise<Dashboard> {
  const made = await createDashboard({ name, config: { widgets: [] } });
  if (!made.ok) throw new Error('create failed');
  return made.dashboard;
}

const revisionOf = async (id: string) => (await getDashboard(id))!.revision;

describe('dashboard revision', () => {
  beforeEach(async () => { await resetDb(); await clearDashboards(); });

  it('starts at 1 on create, duplicate and the restored starter', async () => {
    const first = await dashboardNamed(unique('First'));
    const copy = await duplicateDashboard(first.id);
    const starter = await createStarterDashboard();

    expect([first.revision, copy!.revision, starter.revision]).toEqual([1, 1, 1]);
  });

  it('bumps on a layout save, a rename and a filter save, and returns the new value', async () => {
    const d = await dashboardNamed(unique('Bumped'));

    const layout = await updateDashboard(d.id, { config: { widgets: [] , autoRefresh: 60 } });
    const renamed = await updateDashboard(d.id, { name: unique('Renamed') });
    const filtered = await updateDashboard(d.id, {
      config: { widgets: [], filters: { severities: ['high'] }, dateWindow: { mode: 'relative', days: 30 } },
    });

    expect(layout.ok && layout.dashboard.revision).toBe(2);
    expect(renamed.ok && renamed.dashboard.revision).toBe(3);
    expect(filtered.ok && filtered.dashboard.revision).toBe(4);
    expect(await revisionOf(d.id)).toBe(4);
  });

  it('does not bump when the write is refused', async () => {
    const a = await dashboardNamed(unique('Taken'));
    const b = await dashboardNamed(unique('Other'));

    const clash = await updateDashboard(b.id, { name: a.name.toUpperCase() });

    expect(clash.ok).toBe(false);
    expect(await revisionOf(b.id)).toBe(1);
  });

  it('bumps the rows whose default flag changes, and leaves the rest', async () => {
    const a = await dashboardNamed(unique('Default A'));
    const b = await dashboardNamed(unique('Default B'));
    const c = await dashboardNamed(unique('Default C'));

    await setDefaultDashboard(b.id);

    expect([await revisionOf(a.id), await revisionOf(b.id), await revisionOf(c.id)]).toEqual([2, 2, 1]);
  });

  it('bumps the dashboard promoted to default when the default is deleted', async () => {
    const a = await dashboardNamed(unique('Deleted default'));
    const b = await dashboardNamed(unique('Promoted'));

    await deleteDashboard(a.id);

    expect(await revisionOf(b.id)).toBe(2);
  });
});

describe('saved view revision', () => {
  beforeEach(async () => { await resetDb(); });

  it('starts at 1 and bumps on every update', async () => {
    const made = await createSavedView({ name: unique('View'), tab: 'results', query: 'severity=high' }, null);
    if (!made.ok) throw new Error('create failed');
    expect(made.view.revision).toBe(1);

    const renamed = await updateSavedView(made.view.id, { name: unique('Renamed view') }, null);
    const requeried = await updateSavedView(made.view.id, { query: 'severity=critical' }, null);

    expect(renamed.ok && renamed.view.revision).toBe(2);
    expect(requeried.ok && requeried.view.revision).toBe(3);
    expect((await getSavedView(made.view.id))!.revision).toBe(3);
  });

  it('does not bump when the update is refused', async () => {
    const a = await createSavedView({ name: unique('Taken view'), tab: 'results', query: '' }, null);
    const b = await createSavedView({ name: unique('Other view'), tab: 'results', query: '' }, null);
    if (!a.ok || !b.ok) throw new Error('create failed');

    const clash = await updateSavedView(b.view.id, { name: a.view.name.toUpperCase() }, null);

    expect(clash.ok).toBe(false);
    expect((await getSavedView(b.view.id))!.revision).toBe(1);
  });
});
