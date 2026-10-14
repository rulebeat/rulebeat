/**
 * #279: a sign-in starts a background refresh of that person's Mirrored access and never waits for it. The
 * `jwt` callback of the real auth config, over a fake reader whose first read is held open by the test. Only the
 * tenant id and the reader are replaced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { buildAuthConfig } from '@/auth';
import { createUser, getUser, setManualAccess, setMirroredAccess } from '@/lib/db/users';
import { listAssignmentsFor } from '@/lib/db/role-assignments';
import { listAllAuditEntries } from '@/lib/db/audit';
import { startSignInMirrorRefresh } from '@/lib/access-mirror-refresh';
import {
  ACCOUNT, MIRROR_TENANT, SUB_A, SUB_B, fakeRoleAssignments, type FakeRoleAssignments,
} from '../helpers/fake-role-assignments';

const mockTenant = vi.fn();
vi.mock('@/lib/arm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/arm')>()),
  getArmTenantId: () => mockTenant(),
}));

let azure: FakeRoleAssignments;
let release: () => void;
let gate: Promise<void>;
vi.mock('@/lib/access-mirror', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/access-mirror')>();
  const deps = () => ({
    read: {
      ...azure.read,
      listScopes: async () => { await gate; return azure.read.listScopes(); },
    } as typeof azure.read,
    wait: async () => undefined,
  });
  return {
    ...actual,
    refreshMirroredUser: (user: Parameters<typeof actual.refreshMirroredUser>[0]) => actual.refreshMirroredUser(user, deps()),
  };
});

const T0 = new Date('2026-06-02T00:00:00.000Z');

beforeEach(async () => {
  await resetDb();
  mockTenant.mockReset();
  mockTenant.mockResolvedValue(MIRROR_TENANT);
  azure = fakeRoleAssignments();
  azure.assignments = [{ objectId: ACCOUNT, scope: SUB_B, role: 'Reader' }];
  gate = new Promise<void>(resolve => { release = resolve; });
});

async function signIn(userId: string) {
  const config = await buildAuthConfig();
  const jwt = config.callbacks!.jwt!;
  return jwt({ token: {}, user: { id: userId }, account: { provider: 'credentials' } } as never);
}

async function mirroredViewer() {
  const created = await createUser({ email: 'viewer@example.com', role: 'viewer' });
  if ('error' in created) throw new Error(created.error);
  await setMirroredAccess(created.user.id, {
    role: 'viewer', tenantId: MIRROR_TENANT, objectId: ACCOUNT, at: T0.toISOString(),
    scopes: [{ scope: SUB_A, origins: [{ roleName: 'Reader', throughGroup: false, eligible: false }] }],
  });
  return created.user.id;
}

describe('a sign-in by a mirrored person', () => {
  it('completes while the read is still pending, leaves the mirror as it was, then records the refresh', async () => {
    const id = await mirroredViewer();
    const before = (await getUser(id))!.mirror;

    const token = await signIn(id);

    expect(token).toMatchObject({ uid: id });
    expect((await getUser(id))!.mirror).toEqual(before);
    expect((await listAssignmentsFor(id)).map(r => r.scope)).toEqual([SUB_A]);

    release();
    await vi.waitFor(async () => {
      const after = (await getUser(id))!;
      expect(after.mirror?.lastSuccessAt).not.toBe(T0.toISOString());
      expect(after.mirror?.error).toBeNull();
    });
    expect((await listAssignmentsFor(id)).map(r => r.scope)).toEqual([SUB_B]);
  });

  it('writes no audit entry', async () => {
    const id = await mirroredViewer();
    const entries = (await listAllAuditEntries()).length;
    release();

    await signIn(id);
    await vi.waitFor(async () => expect((await getUser(id))!.mirror?.lastSuccessAt).not.toBe(T0.toISOString()));

    expect((await listAllAuditEntries()).length).toBe(entries);
  });

  it('still completes, and logs, when the refresh itself cannot start', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    release();

    await expect(startSignInMirrorRefresh('no-such-user')).resolves.toBeUndefined();
    expect((await signIn('no-such-user'))?.uid).toBe('no-such-user');
    quiet.mockRestore();
  });
});

describe('a sign-in that has nothing to mirror', () => {
  it('starts no read for a Manual person', async () => {
    const created = await createUser({ email: 'manual@example.com', role: 'viewer' });
    if ('error' in created) throw new Error(created.error);
    await setManualAccess(created.user.id, [{ tenantId: MIRROR_TENANT, scope: SUB_A, role: 'viewer' }]);
    release();

    await signIn(created.user.id);
    await new Promise(resolve => setTimeout(resolve, 50));
    await startSignInMirrorRefresh(created.user.id);

    expect(azure.calls).toEqual([]);
    expect((await listAssignmentsFor(created.user.id)).map(r => r.scope)).toEqual([SUB_A]);
  });

  it('starts no read for an Admin', async () => {
    const created = await createUser({ email: 'admin@example.com', role: 'admin' });
    if ('error' in created) throw new Error(created.error);
    release();

    await signIn(created.user.id);
    await new Promise(resolve => setTimeout(resolve, 50));
    await startSignInMirrorRefresh(created.user.id);

    expect(azure.calls).toEqual([]);
  });
});
