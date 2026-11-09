/**
 * A layout save never touches the filters saved on a dashboard (ADR 0013). The client no longer sends
 * them, and the server keeps what is stored whatever the body says, so an old tab that still does send
 * them cannot overwrite the saved filters or the window.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createUser } from '@/lib/db/users';
import { createDashboard, getDashboard, listDashboards } from '@/lib/db/dashboards';
import type { WidgetDef } from '@/lib/types';
import { resetDb } from '../helpers/db';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const { PUT } = await import('@/app/api/dashboards/[id]/route');

const widget = (id: string, x = 0): WidgetDef => ({ id, type: 'stat-card', title: id, x, y: 0, w: 4, h: 4, config: {} }) as WidgetDef;
const STORED_FILTERS = { subscriptions: ['sub-1'], severities: ['high' as const] };

let id: string;
beforeEach(async () => {
  await resetDb();
  const created = await createUser({ email: 'editor@example.com', role: 'admin' });
  if ('error' in created) throw new Error(created.error);
  mockAuth.mockResolvedValue({ user: { uid: created.user.id } });
  const dashboard = await createDashboard({
    name: `layout ${crypto.randomUUID()}`,
    config: { widgets: [widget('a')], filters: STORED_FILTERS, dateWindow: { mode: 'relative', days: 30 } },
  });
  if (!dashboard.ok) throw new Error(dashboard.reason);
  id = dashboard.dashboard.id;
});

const put = (body: unknown) => PUT(
  new Request(`http://localhost/api/dashboards/${id}`, { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  { params: Promise.resolve({ id }) },
);

const CHANGED = 'This dashboard changed since you opened it. Reload to continue.';
const revisionNow = async () => (await getDashboard(id))!.revision;

describe('a layout save', () => {
  it('moves the widgets and leaves the saved filters and window as stored', async () => {
    const res = await put({ revision: await revisionNow(), config: { widgets: [widget('a', 4)], autoRefresh: 60 } });
    expect(res.status).toBe(200);
    const stored = (await getDashboard(id))!.config;
    expect(stored.widgets[0]!.x).toBe(4);
    expect(stored.autoRefresh).toBe(60);
    expect(stored.filters).toEqual(STORED_FILTERS);
    expect(stored.dateWindow).toEqual({ mode: 'relative', days: 30 });
  });

  it('ignores filters and a window in the body', async () => {
    await put({ revision: await revisionNow(), config: { widgets: [widget('a')], filters: { categories: ['cost'] }, dateWindow: { mode: 'relative', days: 1 }, windowDays: 7 } });
    const stored = (await getDashboard(id))!.config;
    expect(stored.filters).toEqual(STORED_FILTERS);
    expect(stored.dateWindow).toEqual({ mode: 'relative', days: 30 });
    expect(stored.windowDays).toBeUndefined();
  });
});

describe('a write that carries no revision', () => {
  it('answers 409 with the stated copy and writes nothing when it carries a config', async () => {
    const before = (await getDashboard(id))!;
    const res = await put({ config: { widgets: [widget('a', 8)], autoRefresh: 30 } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: CHANGED });
    expect((await getDashboard(id))).toEqual(before);
  });

  it('answers 409 and writes nothing when it carries a name or description', async () => {
    const before = (await getDashboard(id))!;
    for (const body of [{ name: 'Renamed' }, { description: 'New words' }]) {
      const res = await put(body);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: CHANGED });
    }
    expect((await getDashboard(id))).toEqual(before);
  });

  it('does not make a dashboard the default when the same request also needs a revision', async () => {
    const other = await createDashboard({ name: `other ${crypto.randomUUID()}`, config: { widgets: [] } });
    if (!other.ok) throw new Error(other.reason);
    const defaultBefore = (await listDashboards()).find(d => d.isDefault)!.id;
    const res = await put({ isDefault: true, name: 'Renamed' });
    expect(res.status).toBe(409);
    expect((await listDashboards()).find(d => d.isDefault)!.id).toBe(defaultBefore);
  });

  it('still accepts a request that sends only isDefault', async () => {
    const other = await createDashboard({ name: `other ${crypto.randomUUID()}`, config: { widgets: [] } });
    if (!other.ok) throw new Error(other.reason);
    const res = await put({ isDefault: true });
    expect(res.status).toBe(200);
    expect((await getDashboard(id))!.isDefault).toBe(true);
  });
});

describe('a write that carries the revision', () => {
  it('renames, answers the new revision and keeps the saved filters', async () => {
    const before = await revisionNow();
    const res = await put({ name: 'Renamed', revision: before });
    expect(res.status).toBe(200);
    const body = await res.json() as { name: string; revision: number };
    expect(body.name).toBe('Renamed');
    expect(body.revision).toBe(before + 1);
    expect((await getDashboard(id))!.config.filters).toEqual(STORED_FILTERS);
  });
});
