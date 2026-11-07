/**
 * The ordinary dashboard page and Present answer from one decision, `getOpenableDashboard`. The decision is
 * stubbed to refuse one dashboard, so what is pinned is that each page asks it, not what it decides today.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDashboards, resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { createDashboard } from '@/lib/db/dashboards';
import { setOnboardingState } from '@/lib/onboarding';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

let refusedId: string | null = null;
vi.mock('@/lib/dashboard-visibility', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/dashboard-visibility')>();
  return {
    ...original,
    getOpenableDashboard: (user: Parameters<typeof original.getOpenableDashboard>[0], id: string) =>
      id === refusedId ? Promise.resolve(null) : original.getOpenableDashboard(user, id),
  };
});

const { default: DashboardPage, generateMetadata: pageTitle } = await import('@/app/(app)/dashboards/[id]/page');
const { default: PresentPage, generateMetadata: presentTitle } = await import('@/app/dashboards/[id]/present/page');

async function is404(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (error) {
    if ((error as { digest?: string }).digest === 'NEXT_HTTP_ERROR_FALLBACK;404') return true;
    throw error;
  }
}

beforeEach(async () => {
  await resetDb();
  await clearDashboards();
  mockAuth.mockReset();
  refusedId = null;
  await setOnboardingState({ status: 'done' });
  const created = await createUser({ email: 'admin@example.com', role: 'admin' });
  if ('error' in created) throw new Error(created.error);
  mockAuth.mockResolvedValue({ user: { uid: created.user.id } });
});

async function makeDashboard(name: string) {
  const made = await createDashboard({ name, config: { widgets: [], filters: {} } });
  if (!made.ok) throw new Error(made.reason);
  return made.dashboard;
}

describe('a dashboard the visibility check refuses', () => {
  it('is a 404 on the ordinary page and on Present alike', async () => {
    const dashboard = await makeDashboard('Mine');
    refusedId = dashboard.id;
    const params = Promise.resolve({ id: dashboard.id });
    expect(await is404(() => DashboardPage({ params }))).toBe(true);
    expect(await is404(() => PresentPage({ params, searchParams: Promise.resolve({}) }))).toBe(true);
  });

  it('has the fallback title on the ordinary page and on Present alike', async () => {
    const dashboard = await makeDashboard('Mine');
    refusedId = dashboard.id;
    const params = Promise.resolve({ id: dashboard.id });
    expect(await pageTitle({ params })).toEqual({ title: 'Dashboard · RuleBeat' });
    expect(await presentTitle({ params })).toEqual({ title: 'Dashboard · RuleBeat' });
  });

  it('still opens a dashboard it does not refuse', async () => {
    const dashboard = await makeDashboard('Security posture');
    const params = Promise.resolve({ id: dashboard.id });
    expect(await is404(() => DashboardPage({ params }))).toBe(false);
    expect(await pageTitle({ params })).toEqual({ title: 'Security posture · RuleBeat' });
  });
});
