/** Settings keeps install configuration only: people moved to the Access page. */
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createUser } from '@/lib/db/users';
import { resetDb } from '../helpers/db';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));
const { default: SettingsPage } = await import('@/app/(app)/settings/page');

function nodesOf(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  const found: ReactElement<Record<string, unknown>>[] = [];
  const queue: ReactNode[] = [node];
  while (queue.length > 0) {
    const next = queue.shift();
    if (Array.isArray(next)) { queue.push(...next); continue; }
    if (!isValidElement(next)) continue;
    const element = next as ReactElement<Record<string, unknown>>;
    found.push(element);
    queue.push(element.props.children as ReactNode);
  }
  return found;
}

beforeEach(async () => {
  await resetDb();
  const admin = await createUser({ email: 'admin@example.com', role: 'admin' });
  if ('error' in admin) throw new Error(admin.error);
  mockAuth.mockResolvedValue({ user: { uid: admin.user.id } });
});

describe('the Settings page for an admin', () => {
  it('passes the client no user list and no current user', async () => {
    const tree = nodesOf(await SettingsPage());
    const client = tree.find(el => 'initialCategories' in el.props);
    expect(client).toBeDefined();
    expect('initialUsers' in client!.props).toBe(false);
    expect('initialUsersWithPassword' in client!.props).toBe(false);
    expect('currentUserId' in client!.props).toBe(false);
  });

  it('describes install configuration without mentioning users', async () => {
    const tree = nodesOf(await SettingsPage());
    const header = tree.find(el => el.props.title === 'Settings');
    expect(header).toBeDefined();
    expect(String(header!.props.description)).not.toMatch(/user/i);
  });
});
