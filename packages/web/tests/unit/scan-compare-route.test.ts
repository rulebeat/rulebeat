/**
 * Issue #218 (ADR 0008): a compare of two past scans is answered by the server from their records in
 * `scan_findings`, matched by fingerprint. Driven through the route over scans stored by runCategoryScan()
 * and fake Azure, and checked against the fingerprints the database itself holds, so the sides, their
 * totals, their order and their paging are asserted from the stored records and not from the code under test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { many, run as execRun } from '@/lib/db/exec';
import { scanFindings, scans as scansTable } from '@/lib/db/tables';
import { COMPARE_ERRORS, type CompareResponse, type CompareSide } from '@/lib/compare-response';
import { resetDb } from '../helpers/db';
import { scan, type Seed } from '../helpers/stored-scans';

const mockRequireRole = vi.fn();
vi.mock('@/lib/api-auth', () => ({ requireRole: (...args: unknown[]) => mockRequireRole(...args) }));

const route = await import('@/app/api/scans/compare/route');

const names = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(4, '0')}`);

const get = (query: string) => route.GET(new Request(`http://localhost/api/scans/compare?${query}`));
const compare = async (older: string, newer: string, extra = ''): Promise<CompareResponse> => {
  const res = await get(`compare=${older}..${newer}${extra ? `&${extra}` : ''}`);
  expect(res.status).toBe(200);
  return await res.json() as CompareResponse;
};

const RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
type Stored = typeof scanFindings.$inferSelect;
const storedOf = (scanId: string): Promise<Stored[]> => many(db.select().from(scanFindings).where(eq(scanFindings.scanId, scanId)));
const inOrder = (rows: Stored[]) => [...rows].sort((a, b) =>
  (RANK[a.severity] ?? 5) - (RANK[b.severity] ?? 5) || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) || (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0));

/** What each side must hold, worked out from the stored records of the two scans. */
async function expectedSides(olderId: string, newerId: string): Promise<Record<CompareSide, Stored[]>> {
  const older = await storedOf(olderId);
  const newer = await storedOf(newerId);
  const olderFps = new Set(older.map(r => r.fingerprint));
  const newerFps = new Set(newer.map(r => r.fingerprint));
  return {
    added: inOrder(newer.filter(r => !olderFps.has(r.fingerprint))),
    fixed: inOrder(older.filter(r => !newerFps.has(r.fingerprint))),
    persisted: inOrder(newer.filter(r => olderFps.has(r.fingerprint))),
  };
}

const BEFORE: Seed[] = [
  { id: 'cmp-a', name: 'a rule', severity: 'high', vms: ['vm-a', 'vm-b'] },
  { id: 'cmp-b', name: 'b rule', severity: 'critical', vms: ['vm-a'] },
  { id: 'cmp-c', name: 'c rule', severity: 'low', vms: ['vm-x'] },
];
const AFTER: Seed[] = [
  { id: 'cmp-a', name: 'a rule', severity: 'medium', vms: ['vm-b', 'vm-c'] },
  { id: 'cmp-b', name: 'b rule', severity: 'critical', vms: ['vm-a'] },
  { id: 'cmp-c', name: 'c rule', severity: 'low', vms: [] },
];

beforeEach(async () => {
  await resetDb();
  mockRequireRole.mockResolvedValue({ id: 'viewer' });
});

describe('GET /api/scans/compare: the sides and their totals', () => {
  it('lists each side with the fingerprints the stored records give, and all three totals beside it', async () => {
    const before = await scan(BEFORE, 0);
    const after = await scan(AFTER, 1);
    const expected = await expectedSides(before.id, after.id);
    expect(expected.added).toHaveLength(1);
    expect(expected.fixed).toHaveLength(2);
    expect(expected.persisted).toHaveLength(2);

    for (const side of ['added', 'fixed', 'persisted'] as const) {
      const answer = await compare(before.id, after.id, `compareSide=${side}`);
      expect(answer.side).toBe(side);
      expect(answer.totals).toEqual({ added: 1, fixed: 2, persisted: 2 });
      expect(answer.items.map(i => i.fingerprint), side).toEqual(expected[side].map(r => r.fingerprint));
      expect(answer.page).toBe(1);
      expect(answer.pageCount).toBe(1);
      expect(answer.pageSize).toBe(50);
    }
  });

  it('is the Added side, first page, when the address names no side', async () => {
    const before = await scan(BEFORE, 0);
    const after = await scan(AFTER, 1);
    const answer = await compare(before.id, after.id);
    expect(answer.side).toBe('added');
    expect(answer.items.map(i => i.resourceName)).toEqual(['vm-c']);
  });

  it('lists a persisted finding as the newer scan recorded it', async () => {
    const before = await scan(BEFORE, 0);
    const after = await scan(AFTER, 1);
    const persisted = (await compare(before.id, after.id, 'compareSide=persisted')).items;
    const rule = persisted.find(i => i.ruleId === 'cmp-a');
    // The rule was High in the older scan and Medium in the newer one.
    expect(rule?.severity).toBe('medium');
    expect(persisted.map(i => i.severity)).toEqual(['critical', 'medium']);
  });

  it('reads an added finding as the newer scan recorded it, and a fixed one as the older scan did', async () => {
    const before = await scan(BEFORE, 0);
    const after = await scan(AFTER, 1);
    const fixed = (await compare(before.id, after.id, 'compareSide=fixed')).items;
    expect(fixed.map(i => [i.ruleId, i.resourceName, i.severity])).toEqual([['cmp-a', 'vm-a', 'high'], ['cmp-c', 'vm-x', 'low']]);
  });

  it('says whether each listed finding still exists, and which tab lists it', async () => {
    const before = await scan(BEFORE, 0);
    const after = await scan(AFTER, 1);
    const [added] = (await compare(before.id, after.id)).items;
    expect(added).toMatchObject({ exists: true, tab: 'results' });
  });

  it('has an empty side when nothing is on it, with the other totals still right', async () => {
    const before = await scan(BEFORE, 0);
    const after = await scan(BEFORE, 1);
    const answer = await compare(before.id, after.id);
    expect(answer.items).toEqual([]);
    expect(answer.totals).toEqual({ added: 0, fixed: 0, persisted: 4 });
    expect(answer.pageCount).toBe(1);
  });
});

describe('GET /api/scans/compare: which scan is older', () => {
  it('answers the same whichever order the two ids arrive in, and says which is which', async () => {
    const before = await scan(BEFORE, 0);
    const after = await scan(AFTER, 5);
    const forward = await compare(before.id, after.id, 'compareSide=fixed');
    const backward = await compare(after.id, before.id, 'compareSide=fixed');
    expect(backward).toEqual(forward);
    expect(forward.older.id).toBe(before.id);
    expect(forward.newer.id).toBe(after.id);
    expect(new Date(forward.older.startedAt).getTime()).toBeLessThan(new Date(forward.newer.startedAt).getTime());
    expect(forward.older.category).toBe('identity');
  });

  it('breaks a tie in start time by id, so the two orders still agree', async () => {
    const first = await scan(BEFORE, 0);
    const second = await scan(AFTER, 0);
    await execRun(db.update(scansTable).set({ startedAt: '2026-06-01T00:00:00.000Z' }).where(eq(scansTable.id, first.id)));
    await execRun(db.update(scansTable).set({ startedAt: '2026-06-01T00:00:00.000Z' }).where(eq(scansTable.id, second.id)));
    const forward = await compare(first.id, second.id);
    expect(await compare(second.id, first.id)).toEqual(forward);
    expect(forward.older.id < forward.newer.id).toBe(true);
  });
});

describe('GET /api/scans/compare: order and paging', () => {
  const MANY_BEFORE: Seed[] = [
    { id: 'cmp-many', name: 'many rule', severity: 'high', vms: names('old', 30) },
    { id: 'cmp-keep', name: 'keep rule', severity: 'low', vms: names('keep', 5) },
  ];
  const MANY_AFTER: Seed[] = [
    { id: 'cmp-many', name: 'many rule', severity: 'high', vms: names('new', 120) },
    { id: 'cmp-keep', name: 'keep rule', severity: 'low', vms: names('keep', 5) },
    { id: 'cmp-crit', name: 'zz critical rule', severity: 'critical', vms: names('crit', 3) },
  ];

  it('lists 50 a page in severity, then rule name, then fingerprint order, and no finding twice', async () => {
    const before = await scan(MANY_BEFORE, 0);
    const after = await scan(MANY_AFTER, 1);
    const expected = await expectedSides(before.id, after.id);
    expect(expected.added).toHaveLength(123);

    const pages = [
      await compare(before.id, after.id, 'compareSide=added'),
      await compare(before.id, after.id, 'compareSide=added&comparePage=2'),
      await compare(before.id, after.id, 'compareSide=added&comparePage=3'),
    ];
    expect(pages.map(p => p.items.length)).toEqual([50, 50, 23]);
    expect(pages.map(p => p.page)).toEqual([1, 2, 3]);
    for (const page of pages) expect(page.pageCount).toBe(3);
    const listed = pages.flatMap(p => p.items.map(i => i.fingerprint));
    expect(listed).toEqual(expected.added.map(r => r.fingerprint));
    expect(new Set(listed).size).toBe(123);
    // The critical rule comes first even though its name sorts last; the 120 that share a severity and a
    // rule name are told apart by fingerprint alone.
    expect(pages[0]!.items.slice(0, 3).every(i => i.severity === 'critical')).toBe(true);
  });

  it('holds a page past the end to the last page, and says which page it listed', async () => {
    const before = await scan(MANY_BEFORE, 0);
    const after = await scan(MANY_AFTER, 1);
    const last = await compare(before.id, after.id, 'compareSide=added&comparePage=3');
    const past = await compare(before.id, after.id, 'compareSide=added&comparePage=99');
    expect(past.page).toBe(3);
    expect(past.items.map(i => i.fingerprint)).toEqual(last.items.map(i => i.fingerprint));
  });

  it('keeps every total whichever side and page is on screen', async () => {
    const before = await scan(MANY_BEFORE, 0);
    const after = await scan(MANY_AFTER, 1);
    for (const extra of ['compareSide=fixed', 'compareSide=persisted&comparePage=2', 'compareSide=added&comparePage=3']) {
      expect((await compare(before.id, after.id, extra)).totals, extra).toEqual({ added: 123, fixed: 30, persisted: 5 });
    }
  });

  it('ignores a malformed side or page rather than refusing the request', async () => {
    const before = await scan(BEFORE, 0);
    const after = await scan(AFTER, 1);
    const answer = await compare(before.id, after.id, 'compareSide=bogus&comparePage=-4');
    expect(answer.side).toBe('added');
    expect(answer.page).toBe(1);
  });
});

describe('GET /api/scans/compare: what it refuses', () => {
  it('answers a scan that is unknown or aged out with the 404 and the compare\'s own not-found message', async () => {
    const before = await scan(BEFORE, 0);
    for (const ids of [`${before.id}..no-such-scan`, `no-such-scan..${before.id}`, 'no-such-scan..also-missing']) {
      const res = await get(`compare=${ids}`);
      expect(res.status, ids).toBe(404);
      expect(await res.json()).toEqual(COMPARE_ERRORS['not-found'].body);
    }
  });

  it('answers two scans of different categories with its own code and a status that says the request is wrong', async () => {
    const before = await scan(BEFORE, 0);
    const after = await scan(AFTER, 1);
    await execRun(db.update(scansTable).set({ module: 'security' }).where(eq(scansTable.id, after.id)));
    const res = await get(`compare=${before.id}..${after.id}`);
    expect(res.status).toBe(COMPARE_ERRORS['different-categories'].status);
    expect(await res.json()).toEqual(COMPARE_ERRORS['different-categories'].body);
  });

  it.each([0, 1])('answers a scan whose records are not available as such, never as everything added or fixed (scan %i)', async (which) => {
    const before = await scan(BEFORE, 0);
    const after = await scan(AFTER, 1);
    await execRun(db.update(scansTable).set({ hasRecords: 0 }).where(eq(scansTable.id, [before.id, after.id][which]!)));
    const res = await get(`compare=${before.id}..${after.id}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(COMPARE_ERRORS['no-records'].body);
  });

  it.each(['', 'compare=', 'compare=only-one', 'compare=a..', 'compare=..b', 'compare=a..b..c'])('answers 400 for ids that are not two (%s)', async (query) => {
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(COMPARE_ERRORS['bad-request'].body);
  });
});
