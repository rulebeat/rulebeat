/**
 * #355: a person who holds no Scope still owns their Personal dashboards, so the dashboard page opens them
 * with the editing controls instead of the no-access message. The no-access message is for findings.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { clearDashboards, resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { deleteAssignmentsOn } from '@/lib/db/role-assignments';
import { inTransaction } from '@/lib/db/exec';
import { createDashboard } from '@/lib/db/dashboards';
import { holdsNoScope } from '@/lib/access-model';
import { resolveAccess } from '@/lib/access';
import { NoAccessState } from '@/components/findings/no-access-state';
import { DashboardGridClient } from '@/app/(app)/dashboards/[id]/dashboard-grid-client';
import type { Dashboard } from '@/lib/types';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => '/dashboards',
  useSearchParams: () => new URLSearchParams(),
}));

const { default: DashboardPage } = await import('@/app/(app)/dashboards/[id]/page');

/** Every element type and its props in a React element tree, depth first. */
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

async function viewerWithNoScope() {
  const result = await createUser({ email: `nobody-${Math.random().toString(36).slice(2)}@example.com`, role: 'viewer' });
  if ('error' in result) throw new Error(result.error);
  await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  await inTransaction(tx => deleteAssignmentsOn(tx, result.user.id));
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
  expect(holdsNoScope(await resolveAccess(result.user))).toBe(true);
  return result.user;
}

const render = async (dashboard: Dashboard) => walk(await DashboardPage({ params: Promise.resolve({ id: dashboard.id }) }));

beforeEach(async () => {
  await resetDb();
  await clearDashboards();
  mockAuth.mockReset();
});

describe('the dashboard page for a person with no Scope', () => {
  it('opens their own Personal dashboard with the editing controls', async () => {
    const user = await viewerWithNoScope();
    const made = await createDashboard({ name: 'Mine', config: { widgets: [] } as never }, user.id);
    if (!made.ok) throw new Error(made.reason);
    const tree = await render(made.dashboard);
    expect(tree.some(n => n.type === NoAccessState)).toBe(false);
    const grid = tree.find(n => n.type === DashboardGridClient);
    expect(grid?.props.canChange).toBe(true);
  });
});
