/**
 * Filter changes belong to one dashboard's address (ADR 0013): /dashboard passes its query through the
 * redirect to the default dashboard, and a layout save carries neither the saved filters nor the window.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDashboard, listDashboards } from '@/lib/db/dashboards';
import { layoutConfig } from '@/app/(app)/dashboards/[id]/dashboard-grid-client';
import type { DashboardConfig } from '@/lib/types';
import { resetDb } from '../helpers/db';

const redirect = vi.fn((to: string) => { throw new Error(`redirect:${to}`); });
vi.mock('next/navigation', () => ({
  redirect: (to: string) => redirect(to),
  useRouter: () => ({}), usePathname: () => '', useSearchParams: () => new URLSearchParams(),
}));

const { default: DefaultDashboard } = await import('@/app/(app)/dashboard/page');

async function landing(query: Record<string, string | string[] | undefined>): Promise<string> {
  try {
    await DefaultDashboard({ searchParams: Promise.resolve(query) });
  } catch (e) {
    return (e as Error).message.replace('redirect:', '');
  }
  throw new Error('no redirect');
}

describe('/dashboard', () => {
  let id: string;
  beforeEach(async () => {
    await resetDb();
    const created = await createDashboard({ name: `First ${crypto.randomUUID()}`, config: { widgets: [] } });
    if (!created.ok) throw new Error(created.reason);
    id = (await listDashboards()).find(d => d.isDefault)!.id;
  });

  it('passes its query through to the default dashboard', async () => {
    expect(await landing({ severity: 'high', subscription: ['a', 'b'] })).toBe(`/dashboards/${id}?severity=high&subscription=a&subscription=b`);
  });

  it('redirects bare when it has no query', async () => {
    expect(await landing({})).toBe(`/dashboards/${id}`);
  });
});

describe('a layout save', () => {
  it('leaves out the saved filters, the window and the legacy window', () => {
    const config: DashboardConfig = {
      widgets: [], autoRefresh: 0, filters: { severities: ['high'] }, dateWindow: { mode: 'relative', days: 30 }, windowDays: 7,
    };
    expect(layoutConfig(config, 60, [])).toEqual({ widgets: [], autoRefresh: 60 });
  });
});
