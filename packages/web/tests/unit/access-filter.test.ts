/**
 * #272: the predicate a person's access puts on the findings table, on findings whose stored subscription
 * id and resource group are in a different case from the Scope that covers them (Azure returns the casing
 * it likes, and a Scope keeps whatever casing it was given). The access matrix covers each placement; this
 * covers the comparison on the stored side.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { queryView } from '@/lib/db/finding-views';
import { buildAccess, parseScope, type Access } from '@/lib/access-model';
import { emptyView } from '@/lib/finding-view';
import { resetDb } from '../helpers/db';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';

const QUERY = { tab: 'results', showSuppressed: false } as const;
const SUB = 'AAAAAAAA-0000-0000-0000-00000000000A';

const viewerAt = (...paths: string[]): Access =>
  buildAccess(paths.map(path => ({ tenantId: '', scope: parseScope(path)!, role: 'viewer' as const })), 'manual');
const listed = async (access: Access) =>
  (await queryView(emptyView(), QUERY, access)).items.map(i => i.finding.resourceName).sort();

beforeAll(async () => {
  await resetDb();
  await storeScan([
    syntheticFinding('mixed-case', [{ zone: 'a' }], { ruleId: 'case-rule', subscriptionId: SUB, resourceGroup: 'Rg-Mixed' }),
    syntheticFinding('other-group', [{ zone: 'a' }], { ruleId: 'case-rule', subscriptionId: SUB, resourceGroup: 'Rg-Other' }),
  ], { scanId: '00000000-0000-0000-0000-0000000000c1', finishedAt: '2026-06-01T00:00:00.000Z' });
});

describe('a Scope covers a finding whose stored ids differ from it only in case', () => {
  it('for a subscription Scope', async () => {
    expect(await listed(viewerAt(`/subscriptions/${SUB.toLowerCase()}`))).toEqual(['mixed-case', 'other-group']);
    expect(await listed(viewerAt(`/subscriptions/${SUB}`))).toEqual(['mixed-case', 'other-group']);
  });

  it('for a resource group Scope', async () => {
    expect(await listed(viewerAt(`/subscriptions/${SUB.toLowerCase()}/resourcegroups/rg-mixed`))).toEqual(['mixed-case']);
    expect(await listed(viewerAt(`/SUBSCRIPTIONS/${SUB}/RESOURCEGROUPS/RG-MIXED`))).toEqual(['mixed-case']);
  });

  it('and not for a Scope that names another group or subscription', async () => {
    expect(await listed(viewerAt(`/subscriptions/${SUB}/resourceGroups/rg-nothing`))).toEqual([]);
    expect(await listed(viewerAt('/subscriptions/bbbbbbbb-0000-0000-0000-00000000000b'))).toEqual([]);
  });
});

describe('a management group Scope, by what its expansion holds (#273)', () => {
  const GROUP = '/providers/Microsoft.Management/managementGroups/mg-example';
  const SUB_ONE = '00000000-0000-0000-0000-00000000000a';
  const SUB_TWO = '00000000-0000-0000-0000-00000000000b';

  const holding = (groups: string[], subscriptions: string[], extra: string[] = []): Access => {
    const grants = [GROUP, ...extra].map(path => ({ tenantId: 't', scope: parseScope(path)!, role: 'viewer' as const }));
    return buildAccess(grants, 'manual', [{ tenantId: 't', path: GROUP, role: 'viewer', groups, subscriptions }]);
  };

  beforeAll(async () => {
    await resetDb();
    await storeScan([
      syntheticFinding('vm-one', [{ zone: 'a' }], { ruleId: 'mg-rule', subscriptionId: SUB_ONE, resourceGroup: 'rg-a' }),
      syntheticFinding('vm-two', [{ zone: 'a' }], { ruleId: 'mg-rule', subscriptionId: SUB_TWO, resourceGroup: 'rg-a' }),
      syntheticFinding('sub-level-two', [{ zone: 'a' }], { ruleId: 'mg-rule', placement: 'subscription', subscriptionId: SUB_TWO }),
      syntheticFinding('at-example', [{ zone: 'a' }], { ruleId: 'mg-rule', placement: 'management-group', managementGroupId: 'mg-example' }),
      syntheticFinding('at-child', [{ zone: 'a' }], { ruleId: 'mg-rule', placement: 'management-group', managementGroupId: 'MG-Child' }),
      syntheticFinding('at-above', [{ zone: 'a' }], { ruleId: 'mg-rule', placement: 'management-group', managementGroupId: 'mg-above' }),
      syntheticFinding('directory-app', [{ zone: 'a' }], { ruleId: 'mg-rule', placement: 'directory' }),
      syntheticFinding('unplaceable-thing', [{ zone: 'a' }], { ruleId: 'mg-rule', placement: 'unplaceable' }),
    ], { scanId: '00000000-0000-0000-0000-0000000000c2', finishedAt: '2026-06-01T00:00:00.000Z' });
  });

  it('covers the subscriptions it lists, with their resources and subscription-level findings, and the groups it lists', async () => {
    expect(await listed(holding(['mg-example', 'mg-child'], [SUB_ONE, SUB_TWO])))
      .toEqual(['at-child', 'at-example', 'sub-level-two', 'vm-one', 'vm-two']);
  });

  it('covers only the subscriptions and groups the expansion lists', async () => {
    expect(await listed(holding(['mg-example'], [SUB_ONE]))).toEqual(['at-example', 'vm-one']);
  });

  it('never covers the Directory, a finding RuleBeat could not place, or a group the expansion does not list', async () => {
    const seen = await listed(holding(['mg-example', 'mg-child'], [SUB_ONE, SUB_TWO]));
    for (const name of ['directory-app', 'unplaceable-thing', 'at-above']) expect(seen, name).not.toContain(name);
  });

  it('compares the ids it lists with the stored ones without regard to case', async () => {
    expect(await listed(holding(['MG-EXAMPLE', 'Mg-Child'], [SUB_ONE.toUpperCase()]))).toEqual(['at-child', 'at-example', 'vm-one']);
  });

  it('covers nothing when the expansion is empty, as for a group the tree does not hold', async () => {
    expect(await listed(holding([], []))).toEqual([]);
  });

  it('adds up with the other Scopes a person holds', async () => {
    expect(await listed(holding(['mg-example'], [SUB_ONE], ['@directory']))).toEqual(['at-example', 'directory-app', 'vm-one']);
  });
});
