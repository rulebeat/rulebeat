/**
 * The floor under every context `createTenantContext(access)` hands out (#267): whatever a caller
 * asks for, Azure is only ever asked about what the person holds at some Role. Every route and the
 * scan runner narrow first; these tests are the case where one forgot.
 */
import { describe, expect, it } from 'vitest';
import { buildAccess, type ScopeGrant } from '@/lib/access-model';
import { limitContextToAccess, OUTSIDE_ACCESS_REQUEST_MESSAGE } from '@/lib/access-limited-context';
import { NEEDS_DIRECTORY_MESSAGE, NEEDS_WORKSPACE_SCOPE_MESSAGE } from '@/lib/written-query';
import { expandManagementGroups } from '@/lib/management-group-tree';
import { EVERYTHING_ACCESS } from '../helpers/access';
import { fakeTenantContext, TEST_SUB_A, TEST_SUB_B, TEST_TENANT_ID } from '../helpers/fake-azure';
import { group, subscription } from '../helpers/fake-hierarchy';

const MG_PATH = (id: string) => `/providers/Microsoft.Management/managementGroups/${id}`;
const WORKSPACE_ID = '33333333-3333-3333-3333-333333333333';

const grant = (kind: ScopeGrant['scope']['kind'], path: string): ScopeGrant =>
  ({ tenantId: TEST_TENANT_ID, scope: { kind, path }, role: 'viewer' });

const HIERARCHY = [
  group('mg-root', 'Root', null, TEST_TENANT_ID),
  group('mg-held', 'Held', 'mg-root', TEST_TENANT_ID),
  group('mg-other', 'Other', 'mg-root', TEST_TENANT_ID),
  subscription(TEST_SUB_A, 'Sub A', 'mg-held', TEST_TENANT_ID),
  subscription(TEST_SUB_B, 'Sub B', 'mg-other', TEST_TENANT_ID),
];

const subAOnly = buildAccess([grant('subscription', `/subscriptions/${TEST_SUB_A}`)], 'manual');
const noHierarchy = async () => { throw new Error('the hierarchy should not be read'); };

describe('limitContextToAccess', () => {
  it('sends Resource Graph only the part of the request the person holds', async () => {
    const fake = fakeTenantContext();
    const ctx = limitContextToAccess(fake, subAOnly, noHierarchy);
    await ctx.queryARG('resources', { subscriptions: [TEST_SUB_A, TEST_SUB_B] });
    expect(fake.queries.map(q => q.scope)).toEqual([{ subscriptions: [TEST_SUB_A] }]);
  });

  it('limits a request with no scope to what the person holds, not the whole tenant', async () => {
    const fake = fakeTenantContext();
    const ctx = limitContextToAccess(fake, subAOnly, noHierarchy);
    await ctx.queryARG('resources');
    expect(fake.queries.map(q => q.scope)).toEqual([{ subscriptions: [TEST_SUB_A] }]);
  });

  it('refuses a request that shares nothing with the person, without asking Azure', async () => {
    const fake = fakeTenantContext();
    const ctx = limitContextToAccess(fake, subAOnly, noHierarchy);
    await expect(ctx.queryARG('resources', { subscriptions: [TEST_SUB_B] })).rejects.toThrow(OUTSIDE_ACCESS_REQUEST_MESSAGE);
    expect(fake.queries).toEqual([]);
  });

  it('replaces a management group the person does not hold with the held subscriptions under it', async () => {
    const fake = fakeTenantContext();
    const ctx = limitContextToAccess(fake, subAOnly, async () => HIERARCHY);
    await ctx.queryARG('resources', { managementGroups: ['mg-root'] });
    expect(fake.queries.map(q => q.scope)).toEqual([{ subscriptions: [TEST_SUB_A] }]);
  });

  it('keeps a management group the person holds', async () => {
    const grants = [grant('managementGroup', MG_PATH('mg-held'))];
    const access = buildAccess(grants, 'manual', expandManagementGroups(grants, HIERARCHY));
    const fake = fakeTenantContext();
    const ctx = limitContextToAccess(fake, access, async () => HIERARCHY);
    await ctx.queryARG('resources', { managementGroups: ['mg-held'] });
    expect(fake.queries.map(q => q.scope)).toEqual([{ managementGroups: ['mg-held'] }]);
  });

  it('refuses Microsoft Graph to someone without the Directory', async () => {
    const fake = fakeTenantContext({ graphRows: [{ id: 'app' }] });
    const ctx = limitContextToAccess(fake, subAOnly, noHierarchy);
    await expect(ctx.graphGet('/applications')).rejects.toThrow(NEEDS_DIRECTORY_MESSAGE);
    expect(fake.graphRequests).toEqual([]);
  });

  it('lets someone holding the Directory read Microsoft Graph', async () => {
    const fake = fakeTenantContext({ graphRows: [{ id: 'app' }] });
    const access = buildAccess([grant('directory', '@directory')], 'manual');
    const ctx = limitContextToAccess(fake, access, noHierarchy);
    await expect(ctx.graphGet('/applications')).resolves.toBeDefined();
    expect(fake.graphRequests).toHaveLength(1);
  });

  const workspaceIn = (sub: string) => fakeTenantContext({
    logAnalyticsWorkspaceId: WORKSPACE_ID,
    rows: kql => kql.includes('microsoft.operationalinsights/workspaces')
      ? [{ id: 'ws', subscriptionId: sub, resourceGroup: 'rg-logs', customerId: WORKSPACE_ID }]
      : [],
    logsRows: [{ Caller: 'someone' }],
  });

  it('refuses Log Analytics when the workspace sits outside what the person holds', async () => {
    const fake = workspaceIn(TEST_SUB_B);
    const ctx = limitContextToAccess(fake, subAOnly, noHierarchy);
    await expect(ctx.queryLogs('AzureActivity')).rejects.toThrow(NEEDS_WORKSPACE_SCOPE_MESSAGE);
    expect(fake.logsQueries).toEqual([]);
  });

  it('runs Log Analytics when a held Scope covers the workspace', async () => {
    const fake = workspaceIn(TEST_SUB_A);
    const ctx = limitContextToAccess(fake, subAOnly, noHierarchy);
    await expect(ctx.queryLogs('AzureActivity')).resolves.toEqual([{ Caller: 'someone' }]);
    expect(fake.logsQueries).toEqual(['AzureActivity']);
  });

  it('refuses Log Analytics when no workspace can be placed', async () => {
    const fake = fakeTenantContext({ logsRows: [{ Caller: 'someone' }] });
    const ctx = limitContextToAccess(fake, subAOnly, noHierarchy);
    await expect(ctx.queryLogs('AzureActivity')).rejects.toThrow(NEEDS_WORKSPACE_SCOPE_MESSAGE);
    expect(fake.logsQueries).toEqual([]);
  });

  it('hands back the context untouched for Everything', async () => {
    const fake = fakeTenantContext();
    expect(limitContextToAccess(fake, EVERYTHING_ACCESS, noHierarchy)).toBe(fake);
  });
});
