/**
 * Issue #177, end to end: an Advisory rule that names a Deadline column scans through
 * runCategoryScan() with the fake Azure context. The Deadline is parsed from ISO and epoch values
 * (an unparseable value gives none and the rule still succeeds), follows each sighting, and is
 * kept across a kind switch. Overdue is computed at read time against an injected clock, sorts
 * first, and never enters a posture or problem count.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { rules as rulesTable } from '@/lib/db/tables';
import { getCategory } from '@/lib/db/categories';
import { createUser } from '@/lib/db/users';
import { runCategoryScan } from '@/lib/scan-runner';
import { listFindings } from '@/lib/db/findings';
import { getSnapshots } from '@/lib/db/snapshots';
import { computeWidgetSummary } from '@/lib/dashboard-data';
import { buildExplorerData } from '@/lib/explorer-data';
import { summarizeFindings } from '@/lib/explorer-filters';
import { loadRules, updateRule } from '@/lib/rules';
import { resetDb, clearRules } from '../helpers/db';
import { argRow, fakeTenantContext } from '../helpers/fake-azure';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const PROBLEM = 'dl-e2e-problem';
const ADVISORY = 'dl-e2e-advisory';
const A_MARK = '// marker-advisory';
const P_MARK = '// marker-problem';
const NOW = new Date('2026-06-15T12:00:00.000Z');
const WINDOW = { from: '2000-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z' };
const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const advisoryRows = (): Record<string, unknown>[] => [
  argRow({ name: 'iso-past', retiresOn: '2026-06-01T00:00:00Z' }),
  argRow({ name: 'iso-future', retiresOn: '2026-12-31T00:00:00Z' }),
  argRow({ name: 'secs-past', retiresOn: seconds('2026-05-01T00:00:00Z') }),
  argRow({ name: 'ms-future', retiresOn: Date.parse('2027-03-01T00:00:00Z') }),
  argRow({ name: 'at-now', retiresOn: NOW.toISOString() }),
  argRow({ name: 'garbage', retiresOn: 'next tuesday' }),
  argRow({ name: 'blank', retiresOn: '' }),
  argRow({ name: 'no-column' }),
];
const problemRows = [argRow({ name: 'vm-p1', retiresOn: '2020-01-01T00:00:00Z' })];

async function insertRule(id: string, marker: string, kind: 'state' | 'advisory', deadlineField: string | null): Promise<void> {
  await execRun(db.insert(rulesTable).values({
    id, name: id, description: 'test rule', category: 'security', severity: 'high', enabled: true,
    scope: JSON.stringify({ level: 'subscription' }), resourceTypes: JSON.stringify([]),
    conditions: JSON.stringify([]),
    rawKql: `resources | where type == "microsoft.compute/virtualmachines" ${marker}`,
    type: 'custom', kind, deadlineField,
  }));
}

let advisoryResult: () => Record<string, unknown>[] = advisoryRows;

async function scan() {
  const category = (await getCategory('security'))!;
  return runCategoryScan(category, {
    ctx: fakeTenantContext({ rows: kql => (kql.includes(A_MARK) ? advisoryResult() : problemRows) }),
    ruleIds: [PROBLEM, ADVISORY],
  });
}

const advisories = (now = NOW) => buildExplorerData({ kinds: ['advisory'], now });
const byName = <T extends { resourceName?: string }>(list: T[], name: string): T => list.find(f => f.resourceName === name)!;

beforeEach(async () => {
  await resetDb();
  await clearRules();
  mockAuth.mockReset();
  advisoryResult = advisoryRows;
  const viewer = await createUser({ email: 'viewer@example.com', role: 'viewer' });
  if ('error' in viewer) throw new Error(viewer.error);
  mockAuth.mockResolvedValue({ user: { uid: viewer.user.id } });
  await insertRule(PROBLEM, P_MARK, 'state', 'retiresOn');
  await insertRule(ADVISORY, A_MARK, 'advisory', 'retiresOn');
});

describe('the Deadline of an Advisory finding', () => {
  it('is parsed from ISO, epoch seconds and epoch milliseconds, and is none for anything else', async () => {
    await scan();
    const found = await listFindings();
    const deadline = (name: string) => byName(found.filter(f => f.ruleId === ADVISORY), name).deadline;
    expect(deadline('iso-past')).toBe('2026-06-01T00:00:00.000Z');
    expect(deadline('iso-future')).toBe('2026-12-31T00:00:00.000Z');
    expect(deadline('secs-past')).toBe('2026-05-01T00:00:00.000Z');
    expect(deadline('ms-future')).toBe('2027-03-01T00:00:00.000Z');
    expect(deadline('garbage')).toBeUndefined();
    expect(deadline('blank')).toBeUndefined();
    expect(deadline('no-column')).toBeUndefined();
  });

  it('leaves the rule successful when a value does not parse, with every finding still recorded', async () => {
    const outcome = await scan();
    expect(outcome.summary.coverage).not.toBe('partial');
    expect(outcome.summary.incompleteRules).toEqual([]);
    expect((await listFindings()).filter(f => f.ruleId === ADVISORY)).toHaveLength(8);
  });

  it('is not read for a Problem rule, even one that holds a Deadline column', async () => {
    await scan();
    const problem = (await listFindings()).filter(f => f.ruleId === PROBLEM);
    expect(problem).toHaveLength(1);
    expect(problem[0].deadline).toBeUndefined();
  });

  it('follows the next sighting: a changed date replaces the old one, a missing one clears it', async () => {
    await scan();
    advisoryResult = () => [
      argRow({ name: 'iso-past', retiresOn: '2027-01-01T00:00:00Z' }),
      argRow({ name: 'iso-future' }),
    ];
    await scan();
    const found = (await listFindings()).filter(f => f.ruleId === ADVISORY);
    expect(byName(found, 'iso-past').deadline).toBe('2027-01-01T00:00:00.000Z');
    expect(byName(found, 'iso-future').deadline).toBeUndefined();
  });

  it('is kept, with the column, across a switch to Problem and back, and not shown by Results', async () => {
    await updateRule(ADVISORY, { kind: 'state' });
    expect((await loadRules()).find(r => r.id === ADVISORY)?.deadlineField).toBe('retiresOn');
    await scan();
    expect((await listFindings()).filter(f => f.ruleId === ADVISORY).every(f => f.deadline === undefined)).toBe(true);
    await updateRule(ADVISORY, { kind: 'advisory' });
    await scan();
    expect(byName((await advisories()).findings, 'iso-past').deadline).toBe('2026-06-01T00:00:00.000Z');
  });
});

describe('Overdue', () => {
  it('is an open Advisory whose Deadline is before the injected clock, and nothing else', async () => {
    await scan();
    const { findings } = await advisories();
    const overdue = findings.filter(f => f.overdue).map(f => f.resourceName).sort();
    expect(overdue).toEqual(['iso-past', 'secs-past']);
    expect(byName(findings, 'at-now').overdue).toBe(false);
    expect(byName(findings, 'garbage').overdue).toBe(false);
  });

  it('moves with the clock it is given, not with the date the scan ran', async () => {
    await scan();
    const later = new Date('2028-01-01T00:00:00.000Z');
    expect((await advisories(later)).findings.every(f => f.overdue === !!f.deadline)).toBe(true);
    const earlier = new Date('2020-01-01T00:00:00.000Z');
    expect((await advisories(earlier)).findings.some(f => f.overdue)).toBe(false);
  });

  it('is not set on a fixed Advisory', async () => {
    await scan();
    advisoryResult = () => [argRow({ name: 'iso-future', retiresOn: '2026-12-31T00:00:00Z' })];
    await scan();
    const { findings } = await advisories();
    const past = byName(findings, 'iso-past');
    expect(past.status).toBe('fixed');
    expect(past.deadline).toBe('2026-06-01T00:00:00.000Z');
    expect(past.overdue).toBe(false);
  });

  it('sorts first, then by Deadline ascending with none last', async () => {
    await scan();
    const { findings } = await advisories();
    expect(findings.map(f => f.resourceName)).toEqual([
      'secs-past', 'iso-past',
      'at-now', 'iso-future', 'ms-future',
      expect.stringMatching(/^(garbage|blank|no-column)$/), expect.stringMatching(/^(garbage|blank|no-column)$/), expect.stringMatching(/^(garbage|blank|no-column)$/),
    ]);
  });

  it('is never listed by the Results tab', async () => {
    await scan();
    const results = await buildExplorerData({ now: NOW });
    expect(results.findings.map(f => f.ruleId)).toEqual([PROBLEM]);
    expect(results.findings.some(f => f.overdue)).toBe(false);
  });

  it('stays out of posture, the tiles, the severity breakdown and the daily snapshot', async () => {
    await scan();
    const summary = await computeWidgetSummary({ categories: ['security'], dateWindow: { mode: 'relative', days: 7 } }, 30);
    expect(summary.current.activeFindings).toBe(1);
    expect(summary.current.severityCounts.high).toBe(1);
    expect((await getSnapshots({ categories: ['security'] })).at(-1)?.activeFindings).toBe(1);
    const results = await buildExplorerData({ now: NOW });
    const stats = summarizeFindings(results.findings, WINDOW.from, WINDOW.to);
    expect(stats.total).toBe(1);
    const advisoryStats = summarizeFindings((await advisories()).findings, WINDOW.from, WINDOW.to, ['advisory']);
    expect(advisoryStats.total).toBe(8);
  });
});
