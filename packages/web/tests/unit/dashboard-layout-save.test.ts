/**
 * A layout save never touches the filters saved on a dashboard (ADR 0013). The client no longer sends
 * them, and the server keeps what is stored whatever the body says, so an old tab that still does send
 * them cannot overwrite the saved filters or the window.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createUser } from '@/lib/db/users';
import { createDashboard, getDashboard } from '@/lib/db/dashboards';
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

describe('a layout save', () => {
  it('moves the widgets and leaves the saved filters and window as stored', async () => {
    const res = await put({ config: { widgets: [widget('a', 4)], autoRefresh: 60 } });
    expect(res.status).toBe(200);
    const stored = (await getDashboard(id))!.config;
    expect(stored.widgets[0]!.x).toBe(4);
    expect(stored.autoRefresh).toBe(60);
    expect(stored.filters).toEqual(STORED_FILTERS);
    expect(stored.dateWindow).toEqual({ mode: 'relative', days: 30 });
  });

  it('ignores filters and a window in the body', async () => {
    await put({ config: { widgets: [widget('a')], filters: { categories: ['cost'] }, dateWindow: { mode: 'relative', days: 1 }, windowDays: 7 } });
    const stored = (await getDashboard(id))!.config;
    expect(stored.filters).toEqual(STORED_FILTERS);
    expect(stored.dateWindow).toEqual({ mode: 'relative', days: 30 });
    expect(stored.windowDays).toBeUndefined();
  });
});
