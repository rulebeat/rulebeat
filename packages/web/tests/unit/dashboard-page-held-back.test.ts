/**
 * #363: the dashboard page reads the dashboard and then the list the tabs show. If the dashboard is gone from
 * the second read, the page must not fall back to the stored config, which holds values outside the viewer's
 * Access that never leave the server.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { clearDashboards, resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { createDashboard } from '@/lib/db/dashboards';
import { DashboardGridClient } from '@/app/(app)/dashboards/[id]/dashboard-grid-client';

const mockAuth = vi.fn();
const raceList = vi.hoisted(() => ({ empty: false }));
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => '/dashboards',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/db/dashboards', async importOriginal => {
  const real = await importOriginal<typeof import('@/lib/db/dashboards')>();
  return { ...real, listDashboards: async () => (raceList.empty ? [] : real.listDashboards()) };
});

const { default: DashboardPage } = await import('@/app/(app)/dashboards/[id]/page');

function walk(node: ReactNode, found: Array<{ type: unknown; props: Record<string, unknown> }> = []) {
  if (!node || typeof node !== 'object') return found;
  if (Array.isArray(node)) { node.forEach(child => walk(child, found)); return found; }
  const element = node as { type?: unknown; props?: Record<string, unknown> };
  if (element.props) {
    found.push({ type: element.type, props: element.props });
    walk(element.props.children as ReactNode, found);
  }
  return found;
}

beforeEach(async () => {
  await resetDb();
  await clearDashboards();
  mockAuth.mockReset();
  raceList.empty = false;
});

describe('the dashboard page when the list read no longer holds the dashboard', () => {
  it('never hands the browser the stored config', async () => {
    const result = await createUser({ email: 'owner@example.com', role: 'viewer' });
    if ('error' in result) throw new Error(result.error);
    await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
    mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
    const made = await createDashboard({ name: 'Mine', config: { widgets: [], filters: { subscriptions: ['11111111-1111-1111-1111-111111111111'] } } as never }, result.user.id);
    if (!made.ok) throw new Error(made.reason);

    raceList.empty = true;
    const render = async () => walk(await DashboardPage({ params: Promise.resolve({ id: made.dashboard.id }) }));
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');

    raceList.empty = false;
    const grid = (await render()).find(n => n.type === DashboardGridClient);
    expect(grid?.props.dashboard).toMatchObject({ heldBack: expect.any(Array) });
  });
});
