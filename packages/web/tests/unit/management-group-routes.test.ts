/**
 * #273: GET /api/access/management-groups and POST /api/access/management-groups/refresh, the stored tree
 * and its refresh, for the Admin on the Access page. The real `requireRole` and real repositories, with only
 * the session (`@/auth`) and the reader (the Azure call) replaced. Admin-only, no raw Azure error in any
 * response, and one audit entry that names no group or subscription.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { listAllAuditEntries } from '@/lib/db/audit';
import { listHierarchyNodes } from '@/lib/db/management-group-hierarchy';
import { AzureNotConfiguredError } from '@/lib/azure-credential';
import type { Role } from '@/lib/rbac';
import { fakeHierarchy, group, refreshFrom, subscription, HIERARCHY_TENANT as TENANT, type FakeHierarchy } from '../helpers/fake-hierarchy';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

// Everything but the Azure read is real: the refresh runs over whatever `reading` holds.
let reading: FakeHierarchy;
vi.mock('@/lib/management-group-hierarchy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/management-group-hierarchy')>();
  return {
    ...actual,
    refreshManagementGroupHierarchy: (opts: Parameters<typeof actual.refreshManagementGroupHierarchy>[0] = {}) =>
      actual.refreshManagementGroupHierarchy({ ...opts, read: reading.read }),
  };
});

const { GET } = await import('@/app/api/access/management-groups/route');
const { POST } = await import('@/app/api/access/management-groups/refresh/route');

const SUB_A = '00000000-0000-0000-0000-00000000000a';
const LEAK = 'AuthorizationFailed: client 00000000-aaaa-bbbb-cccc-000000000000 over /subscriptions/secret-sub';

async function signInAs(role: Role): Promise<void> {
  const result = await createUser({ email: `${role}@example.com`, role });
  if ('error' in result) throw new Error(result.error);
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
}

const get = () => GET();
const refresh = () => POST();

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  reading = fakeHierarchy([
    group(TENANT, 'Tenant Root Group', null),
    group('mg-example', 'Example', TENANT),
    subscription(SUB_A, 'Subscription A', 'mg-example'),
  ]);
});

describe('GET /api/access/management-groups', () => {
  it('answers an Admin with nothing loaded yet and a status that says nothing was tried', async () => {
    await signInAs('admin');
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ nodes: [], status: { lastSuccessAt: null, lastAttemptAt: null, error: null } });
    expect(reading.calls).toBe(0);
  });

  it('answers an Admin with the stored tree, no tenant id on a node, and when it was read', async () => {
    await signInAs('admin');
    await refreshFrom(reading, new Date('2026-06-02T00:00:00.000Z'));
    const body = await (await get()).json();
    expect(body.status).toEqual({ lastSuccessAt: '2026-06-02T00:00:00.000Z', lastAttemptAt: '2026-06-02T00:00:00.000Z', error: null });
    expect(body.nodes).toEqual(expect.arrayContaining([
      { id: 'mg-example', kind: 'managementGroup', name: 'Example', parentId: TENANT },
      { id: SUB_A, kind: 'subscription', name: 'Subscription A', parentId: 'mg-example' },
    ]));
    expect(body.nodes).toHaveLength(3);
    expect(JSON.stringify(body.nodes)).not.toContain('tenantId');
  });

  it.each(['viewer', 'editor'] as const)('refuses a %s with a 403 and gives no tree', async (role) => {
    await signInAs('admin');
    await refreshFrom(reading);
    await signInAs(role);
    const res = await get();
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toMatch(/mg-example|Example|Subscription A/);
  });

  it('answers 401 with no session', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
  });
});

describe('POST /api/access/management-groups/refresh', () => {
  it('reads the tree, stores it and answers with the tree and status as the GET does', async () => {
    await signInAs('admin');
    const res = await refresh();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes).toHaveLength(3);
    expect(body.status.error).toBeNull();
    expect(body.status.lastSuccessAt).not.toBeNull();
    expect(await listHierarchyNodes()).toHaveLength(3);
    expect(await (await get()).json()).toEqual(body);
  });

  it.each(['viewer', 'editor'] as const)('refuses a %s with a 403 and never calls the reader', async (role) => {
    await signInAs(role);
    expect((await refresh()).status).toBe(403);
    expect(reading.calls).toBe(0);
    expect(await listHierarchyNodes()).toEqual([]);
  });

  it('answers 401 with no session', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await refresh()).status).toBe(401);
    expect(reading.calls).toBe(0);
  });

  it('writes one audit entry with a summary and no group, subscription or tenant id', async () => {
    await signInAs('admin');
    await refresh();
    const entries = (await listAllAuditEntries()).filter(e => e.action === 'management_groups.refresh');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ entityType: 'management_group_hierarchy', entityId: null, details: null });
    expect(entries[0]!.summary).toBe('admin@example.com refreshed the management group tree (2 groups, 1 subscription)');
    expect(JSON.stringify(entries[0])).not.toMatch(/mg-example|Example|0000|Subscription A/);
  });

  describe('when the read throws', () => {
    beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => undefined); });

    it('answers 502 with the stable message, keeps the last tree, and holds none of the error text', async () => {
      await signInAs('admin');
      const first = await (await refresh()).json();
      const treeBefore = await listHierarchyNodes();

      reading.failWith = new Error(LEAK);
      reading.nodes = [];
      const res = await refresh();
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toBe('The management group tree could not be read from Azure. Check the RuleBeat server logs for details.');
      expect(body.status.error).toEqual({ code: 'failed', message: body.error });
      expect(body.status.lastSuccessAt).toBe(first.status.lastSuccessAt);
      expect(body.nodes).toHaveLength(3);
      expect(await listHierarchyNodes()).toEqual(treeBefore);
      expect(JSON.stringify(body)).not.toMatch(/AuthorizationFailed|00000000-aaaa|secret-sub/);
    });

    it('answers 503 naming the missing connection when Azure is not connected', async () => {
      await signInAs('admin');
      reading.failWith = new AzureNotConfiguredError('RuleBeat has no Azure credential to scan with.');
      const res = await refresh();
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: 'azure_not_configured', error: 'Azure is not connected, so the management group tree could not be read.' });
    });

    it('writes one audit entry for the failed attempt too, without the error text', async () => {
      await signInAs('admin');
      reading.failWith = new Error(LEAK);
      await refresh();
      const entries = (await listAllAuditEntries()).filter(e => e.action === 'management_groups.refresh');
      expect(entries).toHaveLength(1);
      expect(entries[0]!.summary).toBe('admin@example.com tried to refresh the management group tree and it failed');
      expect(JSON.stringify(entries[0])).not.toMatch(/AuthorizationFailed|00000000|secret-sub/);
    });
  });
});
