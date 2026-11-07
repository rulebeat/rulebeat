/**
 * What the pages show for the two defaults (ADR 0012, #360): the list marks the Install default and the
 * signed-in person's My default, the page `/dashboard` redirects to shows the one-line notice, and a gallery
 * with no Install default says so and offers a way to choose one only to whoever may.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { clearDashboards, execRaw, resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { createDashboard, chooseInstallDefault, getDashboard } from '@/lib/db/dashboards';
import { setMyDefault } from '@/lib/db/default-dashboard';
import { DEFAULT_UNAVAILABLE_MESSAGE, DEFAULT_UNAVAILABLE_NOTICE } from '@/lib/default-dashboards';
import { itemPermissionsFor } from '@/lib/item-access-model';
import { everythingAccess } from '@/lib/access-model';
import { DashboardsGallery } from '@/app/(app)/dashboards/dashboards-gallery';
import { DashboardGridClient } from '@/app/(app)/dashboards/[id]/dashboard-grid-client';
import type { Role } from '@/lib/rbac';
import type { Dashboard } from '@/lib/types';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); },
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => '/dashboards',
  useSearchParams: () => new URLSearchParams(),
}));

const { default: GalleryPage } = await import('@/app/(app)/dashboards/page');
const { default: DashboardPage } = await import('@/app/(app)/dashboards/[id]/page');
const { GET: LIST } = await import('@/app/api/dashboards/route');

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

async function makeUser(role: Role): Promise<string> {
  const result = await createUser({ email: `${role}-${Math.random().toString(36).slice(2)}@example.com`, role });
  if ('error' in result) throw new Error(result.error);
  await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  return result.user.id;
}
const actAs = (id: string) => mockAuth.mockResolvedValue({ user: { uid: id } });

async function dashboardOf(ownerId: string, name: string, shared = false): Promise<Dashboard> {
  const made = await createDashboard({ name, config: { autoRefresh: 0, widgets: [] } }, ownerId);
  if (!made.ok) throw new Error(made.reason);
  if (!shared) return made.dashboard;
  await execRaw(`UPDATE dashboards SET visibility = 'shared' WHERE id = '${made.dashboard.id}'`);
  return (await getDashboard(made.dashboard.id))!;
}

const galleryProps = async (searchParams?: { notice?: string }) =>
  walk(await GalleryPage({ searchParams: Promise.resolve(searchParams ?? {}) })).find(n => n.type === DashboardsGallery)!.props;
const markup = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(DashboardsGallery, props as never));

beforeEach(async () => {
  await resetDb();
  await clearDashboards();
  mockAuth.mockReset();
});

describe('the lists', () => {
  it('mark the Install default for everyone and My default only for the person who chose it', async () => {
    const admin = await makeUser('admin');
    const team = await dashboardOf(admin, 'Team', true);
    const mine = await dashboardOf(admin, 'Mine');
    await chooseInstallDefault(team.id);
    await setMyDefault(admin, mine.id);

    actAs(admin);
    const forAdmin = await (await LIST()).json() as Dashboard[];
    expect(forAdmin.map(d => [d.name, d.isInstallDefault, d.isMyDefault])).toEqual(expect.arrayContaining([['Team', true, false], ['Mine', false, true]]));

    actAs(await makeUser('viewer'));
    const forViewer = await (await LIST()).json() as Dashboard[];
    expect(forViewer.map(d => [d.name, d.isInstallDefault, d.isMyDefault])).toEqual([['Team', true, false]]);
  });

  it('give the gallery page the same marks', async () => {
    const admin = await makeUser('admin');
    const team = await dashboardOf(admin, 'Team', true);
    await chooseInstallDefault(team.id);
    await setMyDefault(admin, team.id);
    actAs(admin);
    const props = await galleryProps();
    expect((props.initialDashboards as Dashboard[]).map(d => [d.isInstallDefault, d.isMyDefault])).toEqual([[true, true]]);
  });
});

describe('the notice', () => {
  it('reaches the gallery for the redirect\'s value and for nothing else', async () => {
    actAs(await makeUser('viewer'));
    expect((await galleryProps({ notice: DEFAULT_UNAVAILABLE_NOTICE })).notice).toBe(DEFAULT_UNAVAILABLE_MESSAGE);
    expect((await galleryProps({ notice: 'something-else' })).notice).toBeNull();
    expect((await galleryProps()).notice).toBeNull();
  });

  it('shows on a dashboard page as one line, only for the redirect\'s value', async () => {
    const admin = await makeUser('admin');
    const team = await dashboardOf(admin, 'Team', true);
    actAs(admin);
    const withNotice = walk(await DashboardPage({ params: Promise.resolve({ id: team.id }), searchParams: Promise.resolve({ notice: DEFAULT_UNAVAILABLE_NOTICE }) }));
    expect(withNotice.some(n => n.props.children === DEFAULT_UNAVAILABLE_MESSAGE)).toBe(true);
    const without = walk(await DashboardPage({ params: Promise.resolve({ id: team.id }), searchParams: Promise.resolve({}) }));
    expect(without.some(n => n.props.children === DEFAULT_UNAVAILABLE_MESSAGE)).toBe(false);
  });
});

describe('the dashboard page', () => {
  it('gives the grid the disabled-with-a-reason decision for the Install default, from the server', async () => {
    const owner = await makeUser('editor');
    const team = await dashboardOf(owner, 'Team', true);
    await chooseInstallDefault(team.id);
    actAs(owner);
    const grid = walk(await DashboardPage({ params: Promise.resolve({ id: team.id }) })).find(n => n.type === DashboardGridClient)!;
    expect(grid.props.installDefaultControl).toEqual({ allowed: true });
    expect((grid.props.dashboard as Dashboard).isInstallDefault).toBe(true);
  });
});

describe('a gallery with no Install default', () => {
  const props = (dashboards: Dashboard[], role: Role) => ({
    initialDashboards: dashboards,
    currentUserId: 'someone',
    permissions: itemPermissionsFor(everythingAccess(role, 'manual'), 'dashboard'),
    shareControl: { allowed: true },
    installDefaultControl: { allowed: role !== 'viewer' },
    notice: null,
  });

  async function shared(name: string): Promise<Dashboard> {
    const owner = await makeUser('editor');
    return dashboardOf(owner, name, true);
  }

  it('says so, and offers to choose one to someone who may manage Shared dashboards', async () => {
    const team = await shared('Team');
    const html = markup(props([team], 'admin'));
    expect(html).toContain('No Install default is set');
    expect(html).toContain('Choose Install default');
  });

  it('says so without the offer to someone who may not', async () => {
    const team = await shared('Team');
    const html = markup(props([team], 'viewer'));
    expect(html).toContain('No Install default is set');
    expect(html).not.toContain('Choose Install default');
  });

  it('says nothing once there is one, and marks it', async () => {
    const team = { ...(await shared('Team')), isDefault: true, isInstallDefault: true };
    const html = markup(props([team], 'admin'));
    expect(html).not.toContain('No Install default is set');
    expect(html).toContain('Install default');
  });

  it('marks My default on its card', async () => {
    const team = { ...(await shared('Team')), isMyDefault: true };
    expect(markup(props([team], 'viewer'))).toContain('My default');
  });
});
