/**
 * `listFindingDigests` is `listFindingSummaries` cut to the fields a count reads: the same findings, in
 * the same access, with the same value in each field it keeps. The dashboard summary reads digests, so a
 * digest that differed would change a number on screen. Stored through the real scan sync.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { listFindingDigests, listFindingSummaries } from '@/lib/db/findings';
import { buildAccess } from '@/lib/access-model';
import { resetDb } from '../helpers/db';
import { EVERYTHING_ACCESS } from '../helpers/access';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';

const DIGEST_FIELDS = ['ruleId', 'fingerprint', 'severity', 'category', 'kind', 'subscriptionId', 'resourceGroup', 'placement', 'status', 'firstSeenAt', 'resolvedAt'] as const;
const pick = <T extends object>(f: T) => Object.fromEntries(DIGEST_FIELDS.map(k => [k, (f as Record<string, unknown>)[k]]));
const byFingerprint = <T extends { fingerprint: string }>(list: T[]) => [...list].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));

beforeEach(async () => { await resetDb(); });

describe('finding digests', () => {
  it('hold the same field values as the summaries of the same findings, open and fixed, under any access', async () => {
    const kept = [
      syntheticFinding('vm-1', [{ n: 1 }], { ruleId: 'r-1', subscriptionId: 'sub-1', resourceGroup: 'rg-a', severity: 'critical' }),
      syntheticFinding('app-1', [{ n: 1 }], { ruleId: 'r-1', placement: 'directory', severity: 'low' }),
      syntheticFinding('mg-1', [{ n: 1 }], { ruleId: 'r-1', placement: 'management-group', managementGroupId: 'mg-x' }),
      syntheticFinding('act-1', [{ n: 1 }], { ruleId: 'r-act', placement: 'workspace', subscriptionId: 'sub-2', resourceGroup: 'rg-w', kind: 'activity' }),
    ];
    const gone = syntheticFinding('vm-gone', [{ n: 1 }], { ruleId: 'r-2', subscriptionId: 'sub-2' });
    await storeScan([...kept, gone], { scanId: 's1', finishedAt: '2026-03-01T00:00:00.000Z' });
    await storeScan(kept, { scanId: 's2', finishedAt: '2026-03-02T00:00:00.000Z', ranRuleIds: ['r-1', 'r-2', 'r-act'] });

    const oneSubscription = buildAccess([{ tenantId: 't', scope: { kind: 'subscription', path: '/subscriptions/sub-1' }, role: 'viewer' }], 'manual');
    for (const access of [EVERYTHING_ACCESS, oneSubscription]) {
      for (const status of ['active', 'fixed'] as const) {
        const summaries = byFingerprint(await listFindingSummaries(access, { status }));
        const digests = byFingerprint(await listFindingDigests(access, { status }));
        expect(digests.map(d => ({ ...d }))).toEqual(summaries.map(pick));
      }
    }
    expect((await listFindingDigests(EVERYTHING_ACCESS, { status: 'fixed' })).map(d => d.resolvedAt)).toEqual([expect.any(String)]);
    expect((await listFindingDigests(EVERYTHING_ACCESS, { status: 'active' })).length).toBe(4);
  });
});
