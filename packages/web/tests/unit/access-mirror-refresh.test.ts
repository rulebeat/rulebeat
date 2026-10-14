/**
 * #279: Mirrored access refreshes by itself. The scheduler pass over every mirrored person (`refreshMirrorsIfDue`,
 * and the same pass inside `tickOnce`) with an injected clock and a fake reader. No Azure: only the tenant id
 * (`@/lib/arm`) is replaced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, clearRules, countRows, execRaw } from '../helpers/db';
import { createUser, getUser, setManualAccess, setMirroredAccess, type AppUser } from '@/lib/db/users';
import { listAssignmentsFor } from '@/lib/db/role-assignments';
import { listAllAuditEntries } from '@/lib/db/audit';
import { createSchedule } from '@/lib/db/schedules';
import { getHierarchyStatus } from '@/lib/db/management-group-hierarchy';
import { resolveAccess } from '@/lib/access';
import { refreshMirrorsIfDue } from '@/lib/access-mirror-refresh';
import { tickOnce } from '@/lib/scheduler';
import { fakeTenantContext } from '../helpers/fake-azure';
import { fakeHierarchy, group, HIERARCHY_TENANT } from '../helpers/fake-hierarchy';
import {
  ACCOUNT, MIRROR_TENANT, OTHER_ACCOUNT, SUB_A, SUB_B, fakeRoleAssignments, placesCalled, type FakeRoleAssignments,
} from '../helpers/fake-role-assignments';

const mockTenant = vi.fn();
vi.mock('@/lib/arm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/arm')>()),
  getArmTenantId: () => mockTenant(),
}));

const MINUTE = 60_000;
const T0 = new Date('2026-06-02T00:00:00.000Z');
const after = (minutes: number) => new Date(T0.getTime() + minutes * MINUTE);
const wait = async (): Promise<void> => undefined;
const sub = (path: string) => ({ scope: path, origins: [{ roleName: 'Reader', throughGroup: false, eligible: false }] });

let azure: FakeRoleAssignments;

beforeEach(async () => {
  await resetDb();
  mockTenant.mockReset();
  mockTenant.mockResolvedValue(MIRROR_TENANT);
  azure = fakeRoleAssignments();
});

async function mirrored(email: string, role: 'viewer' | 'editor', objectId = ACCOUNT, at = T0): Promise<AppUser> {
  const created = await createUser({ email, role });
  if ('error' in created) throw new Error(created.error);
  await setMirroredAccess(created.user.id, { role, tenantId: MIRROR_TENANT, objectId, scopes: [sub(SUB_A)], at: at.toISOString() });
  return (await getUser(created.user.id))!;
}

const pathsOf = async (id: string): Promise<string[]> => (await listAssignmentsFor(id)).map(r => r.scope).sort();

describe('the hourly pass', () => {
  it('refreshes every mirrored Viewer and Editor to what the reader holds, stamped with the injected time', async () => {
    const viewer = await mirrored('viewer@example.com', 'viewer', ACCOUNT);
    const editor = await mirrored('editor@example.com', 'editor', OTHER_ACCOUNT);
    azure.assignments = [
      { objectId: ACCOUNT, scope: SUB_B, role: 'Reader' },
      { objectId: OTHER_ACCOUNT, scope: SUB_A, role: 'Reader' },
      { objectId: OTHER_ACCOUNT, scope: SUB_B, role: 'Owner' },
    ];

    await refreshMirrorsIfDue({ now: after(60), read: azure.read, wait });

    expect(await pathsOf(viewer.id)).toEqual([SUB_B]);
    expect(await pathsOf(editor.id)).toEqual([SUB_A, SUB_B]);
    for (const id of [viewer.id, editor.id]) {
      expect((await getUser(id))!.mirror).toEqual({
        lastSuccessAt: after(60).toISOString(), lastAttemptAt: after(60).toISOString(), error: null,
      });
    }
  });

  it('leaves Manual people and Admins alone and never reads for them', async () => {
    const manual = await createUser({ email: 'manual@example.com', role: 'viewer' });
    if ('error' in manual) throw new Error(manual.error);
    await setManualAccess(manual.user.id, [{ tenantId: MIRROR_TENANT, scope: SUB_A, role: 'viewer' }]);
    const admin = await createUser({ email: 'admin@example.com', role: 'admin' });
    if ('error' in admin) throw new Error(admin.error);
    azure.assignments = [{ objectId: ACCOUNT, scope: SUB_B, role: 'Reader' }];

    await refreshMirrorsIfDue({ now: after(60), read: azure.read, wait });

    expect(azure.calls).toEqual([]);
    expect(await pathsOf(manual.user.id)).toEqual([SUB_A]);
    expect(await pathsOf(admin.user.id)).toEqual([]);
    expect((await getUser(manual.user.id))!.mirror).toBeNull();
  });

  it('does not read a person again before an hour has passed, and does an hour later', async () => {
    await mirrored('viewer@example.com', 'viewer');
    azure.assignments = [{ objectId: ACCOUNT, scope: SUB_B, role: 'Reader' }];

    await refreshMirrorsIfDue({ now: after(30), read: azure.read, wait });
    expect(azure.calls).toEqual([]);

    await refreshMirrorsIfDue({ now: after(60), read: azure.read, wait });
    expect(placesCalled(azure, 'listScopes')).toHaveLength(1);

    azure.calls.length = 0;
    await refreshMirrorsIfDue({ now: after(90), read: azure.read, wait });
    expect(azure.calls).toEqual([]);
  });

  it('counts a failed attempt as an attempt, so a failing reader is not asked again within the hour', async () => {
    await mirrored('viewer@example.com', 'viewer');
    azure.failWith = new Error('down');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await refreshMirrorsIfDue({ now: after(60), read: azure.read, wait });
    const reads = azure.calls.length;
    await refreshMirrorsIfDue({ now: after(90), read: azure.read, wait });

    quiet.mockRestore();
    expect(reads).toBeGreaterThan(0);
    expect(azure.calls).toHaveLength(reads);
  });

  it('drops a Scope from the stored rows and the resolved Access once Azure no longer holds it', async () => {
    const viewer = await mirrored('viewer@example.com', 'viewer');
    azure.assignments = [
      { objectId: ACCOUNT, scope: SUB_A, role: 'Reader' },
      { objectId: ACCOUNT, scope: SUB_B, role: 'Reader' },
    ];
    await refreshMirrorsIfDue({ now: after(60), read: azure.read, wait });
    expect(await pathsOf(viewer.id)).toEqual([SUB_A, SUB_B]);

    azure.assignments = azure.assignments.filter(a => a.scope !== SUB_B);
    await refreshMirrorsIfDue({ now: after(120), read: azure.read, wait });

    expect(await pathsOf(viewer.id)).toEqual([SUB_A]);
    const access = await resolveAccess((await getUser(viewer.id))!);
    expect(access.grants.map(g => g.scope.path)).toEqual([SUB_A]);
  });

  it('records one person\'s failure with a stable code, keeps their Scopes, and still refreshes the others', async () => {
    const failing = await mirrored('a-failing@example.com', 'viewer', OTHER_ACCOUNT);
    const healthy = await mirrored('b-healthy@example.com', 'editor', ACCOUNT);
    azure.assignments = [
      { objectId: ACCOUNT, scope: SUB_B, role: 'Reader' },
      { objectId: OTHER_ACCOUNT, scope: SUB_B, role: 'Reader' },
    ];
    // A reader that fails for one account only, over the same fake data.
    const read = new Proxy(azure.read, {
      get(target, prop) {
        const fn = (target as unknown as Record<string | symbol, unknown>)[prop];
        if (prop !== 'listActive' || typeof fn !== 'function') return fn;
        return (place: string, objectId: string) => {
          if (objectId === OTHER_ACCOUNT) throw new Error('AuthorizationFailed: client 00000000-aaaa-bbbb-cccc-000000000000');
          return (fn as (p: string, o: string) => unknown).call(target, place, objectId);
        };
      },
    });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(refreshMirrorsIfDue({ now: after(60), read, wait })).resolves.toBeUndefined();
    quiet.mockRestore();

    expect(await pathsOf(failing.id)).toEqual([SUB_A]);
    expect((await getUser(failing.id))!.mirror).toEqual({
      lastSuccessAt: T0.toISOString(),
      lastAttemptAt: after(60).toISOString(),
      error: expect.objectContaining({ code: 'failed' }),
    });
    expect(await pathsOf(healthy.id)).toEqual([SUB_B]);
    expect((await getUser(healthy.id))!.mirror).toMatchObject({ lastSuccessAt: after(60).toISOString(), error: null });
  });

  it('writes no audit entry', async () => {
    await mirrored('viewer@example.com', 'viewer');
    azure.assignments = [{ objectId: ACCOUNT, scope: SUB_B, role: 'Reader' }];
    const before = (await listAllAuditEntries()).length;

    await refreshMirrorsIfDue({ now: after(60), read: azure.read, wait });

    expect((await listAllAuditEntries()).length).toBe(before);
  });
});

describe('the scheduler tick', () => {
  async function dueSchedule(): Promise<void> {
    await clearRules();
    const created = await createSchedule({
      name: 'Nightly', targetType: 'all', targetValues: [], recurrenceType: 'daily', interval: 1,
      daysOfWeek: null, dayOfMonth: null, startAt: new Date(T0.getTime() - 2 * 24 * 60 * MINUTE).toISOString(), endType: 'never', endDate: null,
    });
    if ('error' in created) throw new Error(created.error);
    await execRaw(`UPDATE schedules SET next_run_at = '${T0.toISOString()}' WHERE id = '${created.schedule.id}'`);
  }

  it('refreshes due mirrored people after the tree, and runs due schedules', async () => {
    const viewer = await mirrored('viewer@example.com', 'viewer');
    azure.assignments = [{ objectId: ACCOUNT, scope: SUB_B, role: 'Reader' }];
    await dueSchedule();
    const tree = fakeHierarchy([group(HIERARCHY_TENANT, 'Root', null)]);

    await tickOnce({ now: after(60), ctx: fakeTenantContext(), read: tree.read, mirrorRead: azure.read, mirrorWait: wait });

    expect(await pathsOf(viewer.id)).toEqual([SUB_B]);
    expect((await getUser(viewer.id))!.mirror?.lastSuccessAt).toBe(after(60).toISOString());
    expect((await getHierarchyStatus()).lastAttemptAt).toBe(after(60).toISOString());
    expect(await countRows('schedule_runs')).toBe(1);
  });

  it('records a failing reader for the person and still runs the schedule and the tree refresh without throwing', async () => {
    const viewer = await mirrored('viewer@example.com', 'viewer');
    azure.failWith = new Error('down');
    await dueSchedule();
    const tree = fakeHierarchy([group(HIERARCHY_TENANT, 'Root', null)]);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(tickOnce({
      now: after(60), ctx: fakeTenantContext(), read: tree.read, mirrorRead: azure.read, mirrorWait: wait,
    })).resolves.toBeUndefined();
    quiet.mockRestore();

    expect(await pathsOf(viewer.id)).toEqual([SUB_A]);
    expect((await getUser(viewer.id))!.mirror?.error).toMatchObject({ code: 'failed' });
    expect((await getHierarchyStatus()).lastAttemptAt).toBe(after(60).toISOString());
    expect(await countRows('schedule_runs')).toBe(1);
  });
});

