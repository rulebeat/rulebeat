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
