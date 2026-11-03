/**
 * ADR 0012 (#355): removing a person deletes their Personal dashboards and saved views and leaves their
 * Shared ones with no owner. The audit entry and the confirmation the Access page shows give counts only,
 * never the name of an item, since a Personal item's name is its owner's alone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDashboards, execRaw, resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { listAllAuditEntries } from '@/lib/db/audit';
import { createDashboard, getDashboard, listDashboards } from '@/lib/db/dashboards';
import { createSavedView, listSavedViews } from '@/lib/db/saved-views';
import { countOwnedItemsByPerson } from '@/lib/db/item-owners';
import { removalConfirmation } from '@/lib/owned-items-copy';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const { DELETE } = await import('@/app/api/users/[id]/route');

async function makeUser(role: 'viewer' | 'admin') {
  const result = await createUser({ email: `${role}-${Math.random().toString(36).slice(2)}@example.com`, role });
  if ('error' in result) throw new Error(result.error);
  await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  return result.user;
}

const remove = (id: string) => DELETE(new Request('http://localhost/api/users/x', { method: 'DELETE' }), { params: Promise.resolve({ id }) });

async function seedOwner(ownerId: string) {
  const personal = await createDashboard({ name: 'Secret personal dashboard', config: { widgets: [] } as never }, ownerId);
  const shared = await createDashboard({ name: 'Team dashboard', config: { widgets: [] } as never }, ownerId);
  if (!personal.ok || !shared.ok) throw new Error('seed');
  await execRaw(`UPDATE dashboards SET visibility = 'shared' WHERE id = '${shared.dashboard.id}'`);
  const view = await createSavedView({ name: 'Secret personal view', tab: 'results', query: '' }, ownerId);
  const teamView = await createSavedView({ name: 'Team view', tab: 'results', query: '' }, ownerId);
  if (!view.ok || !teamView.ok) throw new Error('seed');
  await execRaw(`UPDATE saved_views SET visibility = 'shared' WHERE id = '${teamView.view.id}'`);
  return { sharedDashboardId: shared.dashboard.id, sharedViewId: teamView.view.id };
}

beforeEach(async () => {
  await resetDb();
  await clearDashboards();
  mockAuth.mockReset();
});

describe('DELETE /api/users/[id] for a person who owns dashboards and saved views', () => {
  it('deletes their Personal items and leaves their Shared ones with no owner', async () => {
    const admin = await makeUser('admin');
    const owner = await makeUser('viewer');
    const { sharedDashboardId, sharedViewId } = await seedOwner(owner.id);
    mockAuth.mockResolvedValue({ user: { uid: admin.id } });

    expect((await remove(owner.id)).status).toBe(200);

    expect((await listDashboards()).map(d => d.name)).toEqual(['Team dashboard']);
    expect(await getDashboard(sharedDashboardId)).toMatchObject({ visibility: 'shared', owner: null });
    expect((await listSavedViews()).map(v => v.name)).toEqual(['Team view']);
    expect((await listSavedViews())[0]).toMatchObject({ id: sharedViewId, visibility: 'shared', owner: null });
  });

  it('writes the counts into the audit entry, and no name of any item', async () => {
    const admin = await makeUser('admin');
    const owner = await makeUser('viewer');
    await seedOwner(owner.id);
    mockAuth.mockResolvedValue({ user: { uid: admin.id } });

    await remove(owner.id);

    const entry = (await listAllAuditEntries()).find(e => e.action === 'user.remove');
    expect(entry?.summary).toContain('1 Personal dashboard and 1 Personal saved view deleted.');
    expect(entry?.summary).toContain('1 Shared dashboard and 1 Shared saved view left Shared with no owner.');
    expect(entry?.details).toMatchObject({ ownedItems: { deletedDashboards: 1, deletedViews: 1, releasedDashboards: 1, releasedViews: 1 } });
    const text = JSON.stringify([entry?.summary, entry?.details]);
    for (const name of ['Secret personal dashboard', 'Secret personal view', 'Team dashboard', 'Team view']) {
      expect(text).not.toContain(name);
    }
  });

  it('adds nothing to the audit entry for a person who owns nothing', async () => {
    const admin = await makeUser('admin');
    const owner = await makeUser('viewer');
    mockAuth.mockResolvedValue({ user: { uid: admin.id } });

    await remove(owner.id);

    const entry = (await listAllAuditEntries()).find(e => e.action === 'user.remove');
    expect(entry?.summary).not.toMatch(/Personal|Shared/);
    expect(JSON.stringify(entry?.details)).not.toContain('ownedItems');
  });
});

describe('the removal confirmation', () => {
  it('gives the counts the Access page loads for the person, and no item name', async () => {
    const owner = await makeUser('viewer');
    await seedOwner(owner.id);
    const text = removalConfirmation('Remove them?', (await countOwnedItemsByPerson())[owner.id]);
    expect(text).toBe('Remove them? 1 Personal dashboard and 1 Personal saved view will be deleted. 1 Shared dashboard and 1 Shared saved view will stay Shared with no owner.');
    expect(text).not.toMatch(/Secret|Team/);
  });

  it('is the bare warning for a person who owns nothing', () => {
    expect(removalConfirmation('Remove them?', undefined)).toBe('Remove them?');
  });
});
