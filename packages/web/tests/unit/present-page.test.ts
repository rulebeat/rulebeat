/**
 * The Present page, `/dashboards/<id>/present`. It sits outside the `(app)` layout, so it repeats that
 * layout's checks itself, and what it hands its client is the dashboard read with the URL filters applied.
 *
 * Driven from the page's default export and `generateMetadata`, the way Next.js calls them, over the real
 * repositories. Only the session and the Demo switch are mocked.
 */
import { isValidElement, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDashboards, countRows, resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { createDashboard } from '@/lib/db/dashboards';
import { setOnboardingState } from '@/lib/onboarding';
import type { Role } from '@/lib/rbac';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

let demo = false;
vi.mock('@/lib/demo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/demo')>()),
  isDemoMode: async () => demo,
}));

const { default: PresentPage, generateMetadata } = await import('@/app/dashboards/[id]/present/page');

type Props = Record<string, unknown>;

function findElement(node: unknown, name: string): ReactElement<Props> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, name);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  const element = node as ReactElement<Props>;
  if ((element.type as { name?: string }).name === name) return element;
  return findElement(element.props.children, name);
}

/** What a call to `notFound()` or `redirect()` threw, as the digest Next.js reads. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'rendered';
  } catch (error) {
    const digest = (error as { digest?: string }).digest;
    if (!digest) throw error;
    if (digest.startsWith('NEXT_REDIRECT')) return `redirect ${digest.split(';')[2]}`;
    if (digest === 'NEXT_HTTP_ERROR_FALLBACK;404') return '404';
    throw error;
  }
}

const present = (id: string, searchParams: Record<string, string | string[] | undefined> = {}) =>
  PresentPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(searchParams) });

async function signInAs(role: Role, email = `${role}@example.com`) {
  const created = await createUser({ email, role });
  if ('error' in created) throw new Error(created.error);
  mockAuth.mockResolvedValue({ user: { uid: created.user.id } });
  return created.user;
}

async function makeDashboard(name = 'Security posture', config = { widgets: [] as never[], filters: { categories: ['security'] } }) {
  const made = await createDashboard({ name, config });
  if (!made.ok) throw new Error(made.reason);
  return made.dashboard;
}

beforeEach(async () => {
  await resetDb();
  await clearDashboards();
  mockAuth.mockReset();
  demo = false;
  await setOnboardingState({ status: 'done' });
});

describe('the layout\'s checks, repeated in the layout\'s order', () => {
  it('sends a signed-out visitor to /signin', async () => {
    const dashboard = await makeDashboard();
    mockAuth.mockResolvedValue(null);
    expect(await outcome(() => present(dashboard.id))).toBe('redirect /signin');
  });

  it('sends a session whose epoch no longer matches to /signin', async () => {
    const dashboard = await makeDashboard();
    const user = await signInAs('admin');
    mockAuth.mockResolvedValue({ user: { uid: user.id, epoch: user.sessionEpoch + 1 } });
    expect(await outcome(() => present(dashboard.id))).toBe('redirect /signin');
  });

  it('sends a temporary password to the password change', async () => {
    const dashboard = await makeDashboard();
    const user = await signInAs('viewer');
    await setPassword(user.id, 'irrelevant-hash', { mustChangePassword: true });
    expect(await outcome(() => present(dashboard.id))).toBe('redirect /change-password');
  });

  it('sends a person who can manage Azure to onboarding while it is pending', async () => {
    const dashboard = await makeDashboard();
    await signInAs('admin');
    await setOnboardingState({ status: 'pending' });
    expect(await outcome(() => present(dashboard.id))).toBe('redirect /onboarding');
  });

  it('does not send a person who cannot manage Azure to onboarding', async () => {
    const dashboard = await makeDashboard();
    await signInAs('viewer');
    await setOnboardingState({ status: 'pending' });
    expect(await outcome(() => present(dashboard.id))).toBe('rendered');
  });

  it('does not send anyone to onboarding in a Demo', async () => {
    const dashboard = await makeDashboard();
    await signInAs('admin');
    await setOnboardingState({ status: 'pending' });
    demo = true;
    expect(await outcome(() => present(dashboard.id))).toBe('rendered');
  });

  it('asks for the password change before onboarding', async () => {
    const dashboard = await makeDashboard();
    const user = await signInAs('admin');
    await setPassword(user.id, 'irrelevant-hash', { mustChangePassword: true });
    await setOnboardingState({ status: 'pending' });
    expect(await outcome(() => present(dashboard.id))).toBe('redirect /change-password');
  });

  it('checks the person before it looks the dashboard up', async () => {
    mockAuth.mockResolvedValue(null);
    expect(await outcome(() => present('no-such-dashboard'))).toBe('redirect /signin');
  });
});

describe('who may present', () => {
  it('answers 404 for an id that is not a dashboard', async () => {
    await signInAs('admin');
    expect(await outcome(() => present('no-such-dashboard'))).toBe('404');
  });

  it('shows a dashboard the person can open', async () => {
    const dashboard = await makeDashboard();
    await signInAs('admin');
    const page = await present(dashboard.id);
    const client = findElement(page, 'PresentGrid');
    expect((client?.props.dashboard as { id: string }).id).toBe(dashboard.id);
  });

  it('is the same decision for a Viewer as for the ordinary page', async () => {
    const dashboard = await makeDashboard();
    await signInAs('viewer');
    expect(await outcome(() => present(dashboard.id))).toBe('rendered');
  });
});

describe('what the page hands its client', () => {
  it('applies the URL filters over the saved ones', async () => {
    const dashboard = await makeDashboard();
    await signInAs('admin');
    const page = await present(dashboard.id, { severities: 'high', refresh: '30s' });
    const client = findElement(page, 'PresentGrid');
    expect(client?.props.filters).toMatchObject({ categories: ['security'], severities: ['high'] });
  });

  it('writes no audit entry', async () => {
    const dashboard = await makeDashboard();
    await signInAs('admin');
    const before = await countRows('audit_log');
    await present(dashboard.id, { refresh: '30s' });
    expect(await countRows('audit_log')).toBe(before);
  });

  it('shows the Demo bar', async () => {
    const dashboard = await makeDashboard();
    await signInAs('admin');
    expect(findElement(await present(dashboard.id), 'DemoBanner')).toBeDefined();
  });
});

describe('the page title', () => {
  const titleOf = (id: string) => generateMetadata({ params: Promise.resolve({ id }) });

  it('is the dashboard\'s name', async () => {
    const dashboard = await makeDashboard('Security posture');
    await signInAs('admin');
    expect(await titleOf(dashboard.id)).toEqual({ title: 'Security posture · RuleBeat' });
  });

  it('falls back where the page would answer 404', async () => {
    await signInAs('admin');
    expect(await titleOf('no-such-dashboard')).toEqual({ title: 'Dashboard · RuleBeat' });
  });

  it('falls back for someone who is signed out, where the page would redirect', async () => {
    const dashboard = await makeDashboard('Security posture');
    mockAuth.mockResolvedValue(null);
    expect(await titleOf(dashboard.id)).toEqual({ title: 'Dashboard · RuleBeat' });
  });
});
