/**
 * #273: reading the management group tree into RuleBeat's own copy, and when the scheduler does it. The
 * default reader runs here against ARM-shaped answers with only the ARM calls (`@/lib/arm`) replaced; every
 * other read goes through an injected fake reader. No Azure, and an `AzureNotConfiguredError` stands for
 * "Azure is not connected".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, clearRules, countRows, execRaw } from '../helpers/db';
import { listHierarchyNodes, getHierarchyStatus } from '@/lib/db/management-group-hierarchy';
import { refreshManagementGroupHierarchy } from '@/lib/management-group-hierarchy';
import { refreshHierarchyIfDue, tickOnce } from '@/lib/scheduler';
import { createSchedule } from '@/lib/db/schedules';
import { AzureNotConfiguredError } from '@/lib/azure-credential';
import { fakeTenantContext } from '../helpers/fake-azure';
import { fakeHierarchy, group, subscription, HIERARCHY_TENANT as TENANT } from '../helpers/fake-hierarchy';

const mockArm = vi.fn();
const mockTenant = vi.fn();
vi.mock('@/lib/arm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/arm')>()),
  getArmTenantId: () => mockTenant(),
  getArmToken: () => Promise.resolve('token'),
  armFetch: (url: string) => mockArm(url),
}));

const SUB_A = '00000000-0000-0000-0000-00000000000a';
const SUB_B = '00000000-0000-0000-0000-00000000000b';
const MINUTE = 60_000;
const T0 = new Date('2026-06-02T00:00:00.000Z');
const after = (minutes: number) => new Date(T0.getTime() + minutes * MINUTE);

beforeEach(async () => {
  await resetDb();
  mockArm.mockReset();
  mockTenant.mockReset();
  mockTenant.mockResolvedValue(TENANT);
});

describe('the default reader', () => {
  const answer = {
    name: TENANT,
    properties: {
      displayName: 'Contoso Root',
      children: [
        {
          name: 'mg-platform', type: '/providers/Microsoft.Management/managementGroups', displayName: 'Platform',
          children: [
            { name: SUB_A, type: '/subscriptions', displayName: 'Subscription A' },
            { name: 'mg-nested', type: '/providers/Microsoft.Management/managementGroups', displayName: 'Nested', children: [] },
          ],
        },
        { name: SUB_B, type: '/subscriptions' },
      ],
    },
  };

  it('stores the tenant root group, every group and every subscription with the group it sits under', async () => {
    mockArm.mockResolvedValue(answer);
    expect(await refreshManagementGroupHierarchy({ now: T0 })).toEqual({ ok: true, groups: 3, subscriptions: 2 });

    const nodes = (await listHierarchyNodes()).map(n => [n.kind, n.id, n.name, n.parentId, n.tenantId]);
    expect(nodes).toEqual(expect.arrayContaining([
      ['managementGroup', TENANT, 'Contoso Root', null, TENANT],
      ['managementGroup', 'mg-platform', 'Platform', TENANT, TENANT],
      ['managementGroup', 'mg-nested', 'Nested', 'mg-platform', TENANT],
      ['subscription', SUB_A, 'Subscription A', 'mg-platform', TENANT],
      // A subscription Azure gave no display name takes its id as its name.
      ['subscription', SUB_B, SUB_B, TENANT, TENANT],
    ]));
    expect(nodes).toHaveLength(5);
  });

  it('asks for the same recursive hierarchy of the tenant root group that the scope tree route does', async () => {
    mockArm.mockResolvedValue(answer);
    await refreshManagementGroupHierarchy({ now: T0 });
    expect(mockArm).toHaveBeenCalledTimes(1);
    expect(mockArm.mock.calls[0]![0]).toBe(
      `https://management.azure.com/providers/Microsoft.Management/managementGroups/${TENANT}?api-version=2020-05-01&$expand=children&$recurse=true`,
    );
  });

  it('records "Azure is not connected" when there is no credential, without logging it as a failure', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockTenant.mockRejectedValue(new AzureNotConfiguredError('RuleBeat has no Azure credential to scan with.'));
    const result = await refreshManagementGroupHierarchy({ now: T0 });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'azure_not_configured' }) });
    expect((await getHierarchyStatus()).error?.message).toBe('Azure is not connected, so the management group tree could not be read.');
    expect(quiet).not.toHaveBeenCalled();
    quiet.mockRestore();
  });

  it('turns an ARM failure into the stable message and keeps its text out of the status and the result', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockArm.mockRejectedValue(new Error('ARM 403: AuthorizationFailed for client 00000000-aaaa-bbbb-cccc-000000000000'));
    const result = await refreshManagementGroupHierarchy({ now: T0 });
    expect(JSON.stringify([result, await getHierarchyStatus()])).not.toMatch(/ARM 403|AuthorizationFailed|00000000-aaaa/);
    expect(quiet).toHaveBeenCalled();
    quiet.mockRestore();
  });
});

describe('a refresh replaces the whole tree', () => {
  it('drops a node the new read no longer has and adds a new one, in one step', async () => {
    const fake = fakeHierarchy([group(TENANT, 'Root', null), group('mg-old', 'Old', TENANT), subscription(SUB_A, 'A', 'mg-old')]);
    await refreshManagementGroupHierarchy({ read: fake.read, now: T0 });
    fake.nodes = [group(TENANT, 'Root', null), group('mg-new', 'New', TENANT), subscription(SUB_A, 'A', 'mg-new')];
    await refreshManagementGroupHierarchy({ read: fake.read, now: after(5) });

    expect((await listHierarchyNodes()).map(n => n.id).sort()).toEqual([TENANT, SUB_A, 'mg-new'].sort());
    expect(await getHierarchyStatus()).toEqual({ lastSuccessAt: after(5).toISOString(), lastAttemptAt: after(5).toISOString(), error: null });
  });

  it('leaves the old tree whole when the new one cannot all be stored, which is what makes the replace one step', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fake = fakeHierarchy([group(TENANT, 'Root', null), group('mg-old', 'Old', TENANT), subscription(SUB_A, 'A', 'mg-old')]);
    await refreshManagementGroupHierarchy({ read: fake.read, now: T0 });
    const before = await listHierarchyNodes();

    // The second row has no name, which the table refuses after the first has already been written.
    fake.nodes = [group('mg-new', 'New', TENANT), { ...group('mg-bad', 'Bad', TENANT), name: null as unknown as string }];
    const result = await refreshManagementGroupHierarchy({ read: fake.read, now: after(5) });

    expect(result.ok).toBe(false);
    expect(await listHierarchyNodes()).toEqual(before);
    expect((await getHierarchyStatus()).lastSuccessAt).toBe(T0.toISOString());
    quiet.mockRestore();
  });

  it('stores a node listed twice in different cases once', async () => {
    const fake = fakeHierarchy([group(TENANT, 'Root', null), subscription(SUB_A, 'A', TENANT), subscription(SUB_A.toUpperCase(), 'A again', TENANT)]);
    expect((await refreshManagementGroupHierarchy({ read: fake.read, now: T0 })).ok).toBe(true);
    expect((await listHierarchyNodes()).filter(n => n.kind === 'subscription')).toHaveLength(1);
  });

  it('a failed read after a good one keeps the time of the good one and moves the time of the attempt', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fake = fakeHierarchy([group(TENANT, 'Root', null)]);
    await refreshManagementGroupHierarchy({ read: fake.read, now: T0 });
    fake.failWith = new Error('boom');
    await refreshManagementGroupHierarchy({ read: fake.read, now: after(90) });
    expect(await getHierarchyStatus()).toMatchObject({
      lastSuccessAt: T0.toISOString(), lastAttemptAt: after(90).toISOString(), error: { code: 'failed' },
    });
    fake.failWith = null;
    await refreshManagementGroupHierarchy({ read: fake.read, now: after(120) });
    expect((await getHierarchyStatus()).error).toBeNull();
    quiet.mockRestore();
  });
});

describe('the scheduler refreshes the tree hourly', () => {
  it('reads when nothing has been tried yet', async () => {
    const fake = fakeHierarchy([group(TENANT, 'Root', null)]);
    await refreshHierarchyIfDue({ now: T0, read: fake.read });
    expect(fake.calls).toBe(1);
    expect(await listHierarchyNodes()).toHaveLength(1);
  });

  it('does not call the reader until the last attempt is an hour old', async () => {
    const fake = fakeHierarchy([group(TENANT, 'Root', null)]);
    await refreshHierarchyIfDue({ now: T0, read: fake.read });
    await refreshHierarchyIfDue({ now: after(59), read: fake.read });
    expect(fake.calls).toBe(1);
    await refreshHierarchyIfDue({ now: after(60), read: fake.read });
    expect(fake.calls).toBe(2);
    await refreshHierarchyIfDue({ now: after(61), read: fake.read });
    expect(fake.calls).toBe(2);
  });

  it('counts a failed attempt as an attempt, so a broken credential is tried once an hour and not every 30 seconds', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fake = fakeHierarchy([]);
    fake.failWith = new Error('boom');
    await refreshHierarchyIfDue({ now: T0, read: fake.read });
    await refreshHierarchyIfDue({ now: after(1), read: fake.read });
    expect(fake.calls).toBe(1);
    quiet.mockRestore();
  });

  it('a reader that throws does not stop a due schedule from running', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await clearRules();
    const created = await createSchedule({
      name: 'Nightly', targetType: 'all', targetValues: [], recurrenceType: 'daily', interval: 1,
      daysOfWeek: null, dayOfMonth: null, startAt: new Date(Date.now() - 2 * 24 * 60 * MINUTE).toISOString(), endType: 'never', endDate: null,
    });
    if ('error' in created) throw new Error(created.error);
    await execRaw(`UPDATE schedules SET next_run_at = '${new Date(Date.now() - MINUTE).toISOString()}' WHERE id = '${created.schedule.id}'`);

    const fake = fakeHierarchy([]);
    fake.failWith = new Error('boom');
    await expect(tickOnce({ ctx: fakeTenantContext(), read: fake.read })).resolves.toBeUndefined();

    expect(fake.calls).toBe(1);
    expect(await countRows('schedule_runs')).toBe(1);
    quiet.mockRestore();
  });
});
