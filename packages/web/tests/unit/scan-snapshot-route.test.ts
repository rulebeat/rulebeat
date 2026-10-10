/**
 * Issue #217 (ADR 0008): the snapshot route answers from a scan's own records, never from the findings
 * blob, in one read: a page of 50, the total for the filters, and the severity and rule values with
 * their counts. Driven through the route over scans stored by runCategoryScan() on the fake Azure
 * context, so what it reads is exactly what a real scan save wrote.
 *
 * Titles are lower-case ASCII throughout: SQLite sorts text by bytes and Postgres by locale, and the
 * contract under test is the order of the ranks, titles and fingerprints, not the collation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { computeFingerprint } from '@rulebeat/core';
import { db } from '@/lib/db/client';
import { many, run as execRun } from '@/lib/db/exec';
import { findings as findingsTable, rules as rulesTable, scans as scansTable } from '@/lib/db/tables';
import { getCategory } from '@/lib/db/categories';
import { deleteRule } from '@/lib/rules';
import { addSuppression } from '@/lib/suppressions';
import { saveScanResult } from '@/lib/scan-history';
import type { SnapshotResponse } from '@/lib/snapshot-response';
import { resetDb } from '../helpers/db';
import { argRow } from '../helpers/fake-azure';
import { scan, type Seed } from '../helpers/stored-scans';

const mockRequireRole = vi.fn();
vi.mock('@/lib/api-auth', () => ({ requireRole: (...args: unknown[]) => mockRequireRole(...args) }));

const snapshot = await import('@/app/api/scans/[id]/snapshot/route');

const get = (scanId: string, query = '') =>
  snapshot.GET(new Request(`http://localhost/api/scans/${scanId}/snapshot${query ? `?${query}` : ''}`), {
    params: Promise.resolve({ id: scanId }),
  });
const read = async (scanId: string, query = ''): Promise<SnapshotResponse> => {
  const res = await get(scanId, query);
  expect(res.status).toBe(200);
  return await res.json() as SnapshotResponse;
};

const RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const byFingerprint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const displayOrder = (a: { severity: string; title: string; fingerprint: string }, b: typeof a) =>
  RANK[a.severity]! - RANK[b.severity]! || byFingerprint(a.title, b.title) || byFingerprint(a.fingerprint, b.fingerprint);

const MIXED: Seed[] = [
  { id: 'snap-low', name: 'low rule', severity: 'low', vms: ['vm-a'] },
  { id: 'snap-crit', name: 'critical rule', severity: 'critical', vms: ['vm-a', 'vm-b'] },
  { id: 'snap-med', name: 'medium rule', severity: 'medium', vms: ['vm-a', 'vm-b', 'vm-c'] },
  { id: 'snap-high', name: 'high rule', severity: 'high', vms: ['vm-b'] },
  { id: 'snap-info', name: 'info rule', severity: 'info', vms: ['vm-c'] },
];

beforeEach(async () => {
  await resetDb();
  mockRequireRole.mockResolvedValue({ id: 'viewer' });
});

describe('GET /api/scans/[id]/snapshot: the page', () => {
  it('lists the scan\'s findings worst first, then by title, then by fingerprint, with the total', async () => {
    const summary = await scan(MIXED);
    const body = await read(summary.id);

    const expected = [...summary.findings].sort(displayOrder);
    expect(summary.findings).toHaveLength(8);
    expect(body).toMatchObject({ total: 8, page: 1, pageCount: 1, pageSize: 50 });
    expect(body.items.map(i => i.fingerprint)).toEqual(expected.map(f => f.fingerprint));
    expect(body.items.map(i => i.severity)).toEqual(['critical', 'critical', 'high', 'medium', 'medium', 'medium', 'low', 'info']);
  });

  it('breaks a tie of severity and title by fingerprint, ascending', async () => {
    const summary = await scan([{ id: 'snap-tie', name: 'same title', severity: 'high', vms: ['vm-1', 'vm-2', 'vm-3', 'vm-4', 'vm-5', 'vm-6'] }]);
    const body = await read(summary.id);
    const fingerprints = body.items.map(i => i.fingerprint);
    expect(fingerprints).toHaveLength(6);
    expect(fingerprints).toEqual([...fingerprints].sort(byFingerprint));
  });

  it('describes each finding as the scan saw it, from its record alone', async () => {
    const summary = await scan([{ id: 'snap-one', name: 'one rule', severity: 'high', vms: ['vm-a'] }]);
    const [item] = (await read(summary.id)).items;
    expect(item).toEqual({
      fingerprint: computeFingerprint('snap-one', String(argRow({ name: 'vm-a' }).id)),
      ruleId: 'snap-one',
      severity: 'high',
      title: 'one rule',
      kind: 'state',
      resourceId: String(argRow({ name: 'vm-a' }).id),
      resourceName: 'vm-a',
      resourceType: 'microsoft.compute/virtualmachines',
      resourceGroup: 'rg-test',
      subscriptionId: String(argRow({ name: 'vm-a' }).subscriptionId),
      rowCount: 1,
      exists: true,
      tab: 'results',
    });
  });

  it('answers from the records, not the findings blob', async () => {
    const summary = await scan([{ id: 'snap-one', name: 'one rule', severity: 'high', vms: ['vm-a', 'vm-b'] }]);
    await execRun(db.update(scansTable).set({ findings: 'not json at all' }).where(eq(scansTable.id, summary.id)));
    expect((await read(summary.id)).total).toBe(2);
  });

  describe('paging', () => {
    const MANY: Seed[] = [{ id: 'snap-many', name: 'many', severity: 'medium', vms: Array.from({ length: 120 }, (_, i) => `vm-${String(i).padStart(3, '0')}`) }];

    it('lists 50 findings a page, and reports the total and the page count of the filters', async () => {
      const summary = await scan(MANY);
      const first = await read(summary.id);
      expect(first).toMatchObject({ total: 120, page: 1, pageCount: 3, pageSize: 50 });
      expect(first.items).toHaveLength(50);

      const second = await read(summary.id, 'snapPage=2');
      const third = await read(summary.id, 'snapPage=3');
      expect([second.items.length, third.items.length]).toEqual([50, 20]);
      const walked = [...first.items, ...second.items, ...third.items].map(i => i.fingerprint);
      expect(new Set(walked).size).toBe(120);
      expect(walked).toEqual([...summary.findings].sort(displayOrder).map(f => f.fingerprint));
    });

    it('holds a page past the end to the last page, and says which page it listed', async () => {
      const summary = await scan(MANY);
      const past = await read(summary.id, 'snapPage=9');
      expect(past).toMatchObject({ total: 120, page: 3, pageCount: 3 });
      expect(past.items).toHaveLength(20);
    });

    it('reads a page that is not a whole number from 1 as the first page', async () => {
      const summary = await scan(MANY);
      for (const page of ['0', '-2', '1.5', 'x', '']) {
        expect((await read(summary.id, `snapPage=${page}`)).page, page).toBe(1);
      }
    });

    it('lists one empty page for a scan with no findings, which is a run that truly had none', async () => {
      const summary = await scan([{ id: 'snap-none', name: 'none', severity: 'low', vms: [] }]);
      expect(await read(summary.id)).toMatchObject({ total: 0, page: 1, pageCount: 1, items: [], facets: { severity: [], rule: [] } });
    });
  });
});

describe('GET /api/scans/[id]/snapshot: filters', () => {
  it('lists only the severities asked for, and the total follows', async () => {
    const summary = await scan(MIXED);
    const body = await read(summary.id, 'snapSeverity=critical&snapSeverity=info');
    expect(body.total).toBe(3);
    expect(body.items.map(i => i.severity)).toEqual(['critical', 'critical', 'info']);
  });

  it('ignores a severity it does not know', async () => {
    const summary = await scan(MIXED);
    expect((await read(summary.id, 'snapSeverity=bogus')).total).toBe(8);
    expect((await read(summary.id, 'snapSeverity=bogus&snapSeverity=high')).total).toBe(1);
  });

  it('lists only the rules asked for', async () => {
    const summary = await scan(MIXED);
    const body = await read(summary.id, 'snapRule=snap-med&snapRule=snap-low');
    expect(body.total).toBe(4);
    expect(new Set(body.items.map(i => i.ruleId))).toEqual(new Set(['snap-med', 'snap-low']));
  });

  it('combines severity, rule and search, each narrowing the others', async () => {
    const summary = await scan(MIXED);
    const body = await read(summary.id, 'snapSeverity=critical&snapSeverity=medium&snapRule=snap-med&snapQ=vm-b');
    expect(body.items.map(i => [i.ruleId, i.resourceName])).toEqual([['snap-med', 'vm-b']]);
    expect(body.total).toBe(1);
  });

  it('pages the filtered list, not the whole scan', async () => {
    const summary = await scan([
      { id: 'snap-big', name: 'big', severity: 'low', vms: Array.from({ length: 70 }, (_, i) => `vm-${String(i).padStart(2, '0')}`) },
      { id: 'snap-top', name: 'top', severity: 'critical', vms: ['vm-00'] },
    ]);
    const body = await read(summary.id, 'snapSeverity=low&snapPage=2');
    expect(body).toMatchObject({ total: 70, page: 2, pageCount: 2 });
    expect(body.items).toHaveLength(20);
  });

  describe('search', () => {
    const SEARCHED: Seed[] = [
      { id: 'snap-s1', name: 'public blob access', severity: 'high', vms: ['VM-Alpha', 'vm_beta', 'vmxbeta'] },
      { id: 'snap-s2', name: 'missing backup', severity: 'medium', vms: ['vm-gamma'] },
    ];

    it('matches a resource name anywhere in the text, ignoring case', async () => {
      const summary = await scan(SEARCHED);
      expect((await read(summary.id, 'snapQ=alpha')).items.map(i => i.resourceName)).toEqual(['VM-Alpha']);
      expect((await read(summary.id, 'snapQ=LPH')).items.map(i => i.resourceName)).toEqual(['VM-Alpha']);
      expect((await read(summary.id, 'snapQ=VM-ALPHA')).items.map(i => i.resourceName)).toEqual(['VM-Alpha']);
    });

    it('matches the rule name, which is the record\'s title', async () => {
      const summary = await scan(SEARCHED);
      const body = await read(summary.id, 'snapQ=BLOB');
      expect(body.total).toBe(3);
      expect(new Set(body.items.map(i => i.ruleId))).toEqual(new Set(['snap-s1']));
    });

    it('matches the resource type', async () => {
      const summary = await scan(SEARCHED);
      expect((await read(summary.id, 'snapQ=Compute/VirtualMachines')).total).toBe(4);
    });

    it('matches the resource id, which holds what the name does not', async () => {
      const summary = await scan(SEARCHED);
      expect((await read(summary.id, 'snapQ=resourcegroups/rg-test')).total).toBe(4);
      expect((await read(summary.id, `snapQ=${encodeURIComponent('/subscriptions/11111111')}`)).total).toBe(4);
    });

    it('matches nothing for text no field holds, and says so with a total of 0', async () => {
      const summary = await scan(SEARCHED);
      expect(await read(summary.id, 'snapQ=zzz-nothing')).toMatchObject({ total: 0, items: [], page: 1, pageCount: 1 });
    });

    it('takes a percent sign and an underscore as themselves, not as wildcards', async () => {
      const summary = await scan(SEARCHED);
      expect((await read(summary.id, 'snapQ=vm_beta')).items.map(i => i.resourceName)).toEqual(['vm_beta']);
      expect((await read(summary.id, 'snapQ=%25')).total).toBe(0);
      expect((await read(summary.id, 'snapQ=_')).items.map(i => i.resourceName)).toEqual(['vm_beta']);
    });

    it('trims the text, and treats blank text as no search', async () => {
      const summary = await scan(SEARCHED);
      expect((await read(summary.id, 'snapQ=%20alpha%20')).total).toBe(1);
      expect((await read(summary.id, 'snapQ=%20%20')).total).toBe(4);
    });
  });

  describe('facets', () => {
    it('counts each severity and rule of the scan, worst severity first, rules by name', async () => {
      const summary = await scan(MIXED);
      const { facets } = await read(summary.id);
      expect(facets.severity).toEqual([
        { value: 'critical', label: 'critical', count: 2 }, { value: 'high', label: 'high', count: 1 },
        { value: 'medium', label: 'medium', count: 3 }, { value: 'low', label: 'low', count: 1 }, { value: 'info', label: 'info', count: 1 },
      ]);
      expect(facets.rule).toEqual([
        { value: 'snap-crit', label: 'critical rule', count: 2 }, { value: 'snap-high', label: 'high rule', count: 1 },
        { value: 'snap-info', label: 'info rule', count: 1 }, { value: 'snap-low', label: 'low rule', count: 1 },
        { value: 'snap-med', label: 'medium rule', count: 3 },
      ]);
    });

    it('counts a facet with every filter but its own, so a chosen value still shows its siblings', async () => {
      const summary = await scan(MIXED);
      const { facets, total } = await read(summary.id, 'snapSeverity=critical&snapRule=snap-med');
      expect(total).toBe(0);
      // Severity counts with the rule filter on and its own lifted: only the medium rule's findings.
      expect(facets.severity).toEqual([{ value: 'medium', label: 'medium', count: 3 }]);
      // Rule counts with the severity filter on and its own lifted: only the critical findings.
      expect(facets.rule).toEqual([{ value: 'snap-crit', label: 'critical rule', count: 2 }]);
    });

    it('applies the search to both facets', async () => {
      const summary = await scan(MIXED);
      const { facets } = await read(summary.id, 'snapQ=vm-c');
      expect(facets.severity.map(f => [f.value, f.count])).toEqual([['medium', 1], ['info', 1]]);
      expect(facets.rule.map(f => [f.value, f.count])).toEqual([['snap-info', 1], ['snap-med', 1]]);
    });
  });
});

describe('GET /api/scans/[id]/snapshot: the live finding', () => {
  it('lists a finding that is suppressed now, as every finding the scan returned', async () => {
    const summary = await scan(MIXED);
    const target = summary.findings.find(f => f.ruleId === 'snap-crit' && f.resourceName === 'vm-a')!;
    await addSuppression({ id: 'sup-1', fingerprint: target.fingerprint, resourceId: target.resourceId, reason: 'accepted', suppressedAt: new Date().toISOString() });

    const body = await read(summary.id);
    expect(body.total).toBe(8);
    expect(body.items.find(i => i.fingerprint === target.fingerprint)).toMatchObject({ exists: true });
  });

  it('says a finding still exists whatever its status, a fixed one included', async () => {
    const first = await scan([{ id: 'snap-fix', name: 'fixable', severity: 'high', vms: ['vm-a', 'vm-b'] }], 0);
    // The next scan no longer sees vm-b, so its finding is fixed but is still a row of the findings table.
    await scan([{ id: 'snap-fix', name: 'fixable', severity: 'high', vms: ['vm-a'] }], 24);
    const fixed = (await many(db.select().from(findingsTable).where(eq(findingsTable.ruleId, 'snap-fix'))))
      .find(f => f.resourceName === 'vm-b')!;
    expect(fixed.status).not.toBe('open');

    const body = await read(first.id);
    expect(body.items.map(i => [i.resourceName, i.exists]).sort()).toEqual([['vm-a', true], ['vm-b', true]]);
  });

  it('says a finding no longer exists once nothing holds its fingerprint, and still lists it', async () => {
    const summary = await scan(MIXED);
    await deleteRule('snap-high');

    const body = await read(summary.id);
    expect(body.total).toBe(8);
    expect(body.items.filter(i => !i.exists).map(i => i.ruleId)).toEqual(['snap-high']);
    expect(body.items.filter(i => i.exists)).toHaveLength(7);
  });

  it('names the tab that lists the live finding: Results for a state finding, Activity for an activity one', async () => {
    const summary = await scan([
      { id: 'snap-state', name: 'a state rule', severity: 'high', vms: ['vm-a'] },
      { id: 'snap-act', name: 'an activity rule', severity: 'medium', users: ['u1', 'u2'] },
    ]);
    const body = await read(summary.id);
    expect(body.items.map(i => [i.ruleId, i.kind, i.tab, i.resourceId])).toEqual([
      ['snap-state', 'state', 'results', String(argRow({ name: 'vm-a' }).id)],
      ['snap-act', 'activity', 'activity', null],
      ['snap-act', 'activity', 'activity', null],
    ]);
  });

  it('keeps a scan\'s own title for a finding when its rule is renamed after the scan', async () => {
    const summary = await scan([{ id: 'snap-one', name: 'first name', severity: 'high', vms: ['vm-a'] }]);
    await execRun(db.update(rulesTable).set({ name: 'second name', severity: 'low' }).where(eq(rulesTable.id, 'snap-one')));
    expect((await read(summary.id)).items[0]).toMatchObject({ title: 'first name', severity: 'high' });
  });
});

describe('GET /api/scans/[id]/snapshot: a run that cannot be listed', () => {
  it('answers 404 with a stable message for a scan that is unknown or aged out', async () => {
    const res = await get('no-such-scan');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'not-found', error: 'This run was not found. It may have aged out of Run History.' });
  });

  it('answers 409 with its own message for a scan whose records are not stored', async () => {
    const summary = await scan(MIXED);
    await execRun(db.update(scansTable).set({ hasRecords: 0 }).where(eq(scansTable.id, summary.id)));
    const res = await get(summary.id);
    expect(res.status).toBe(409);
    const body = await res.json() as { code: string; error: string };
    expect(body.code).toBe('no-records');
    expect(body.error).toMatch(/not available/);
  });

  it('does not take a scan saved with no findings for a scan with no records', async () => {
    const category = (await getCategory('identity'))!;
    const summary = await scan(MIXED);
    await saveScanResult(category.id, { ...summary, id: 'empty-scan', findings: [] }, { id: 'empty-scan' });
    expect(await read('empty-scan')).toMatchObject({ total: 0, items: [] });
  });
});
