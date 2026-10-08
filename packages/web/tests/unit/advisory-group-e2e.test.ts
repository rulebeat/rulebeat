/**
 * Issue #178, end to end: an Advisory rule that names a Group column scans through
 * runCategoryScan() with the fake Azure context. Each finding stores its own group value, which
 * follows every sighting and is read back by the Advisories read model. Grouping those findings
 * (groupAdvisories) changes no count: fixing one resource in a group resolves only that Advisory
 * and leaves its group-mates open.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { rules as rulesTable } from '@/lib/db/tables';
import { getCategory } from '@/lib/db/categories';
import { createUser } from '@/lib/db/users';
import { runCategoryScan } from '@/lib/scan-runner';
import { listFindings } from '@/lib/db/findings';
import { computeWidgetSummary } from '@/lib/dashboard-data';
import { buildExplorerData } from '@/lib/explorer-data';
import { summarizeFindings } from '@/lib/explorer-filters';
import { groupAdvisories } from '@/lib/advisory-groups';
import { loadRules, updateRule } from '@/lib/rules';
import { resetDb, clearRules } from '../helpers/db';
import { argRow, fakeTenantContext } from '../helpers/fake-azure';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const PROBLEM = 'gr-e2e-problem';
const ADVISORY = 'gr-e2e-advisory';
const A_MARK = '// marker-advisory';
const P_MARK = '// marker-problem';
const NOW = new Date('2026-06-15T12:00:00.000Z');
const WINDOW = { from: '2000-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z' };

const advisoryRows = (): Record<string, unknown>[] => [
  argRow({ name: 'vm-a1', owner: 'platform', retiresOn: '2026-06-01T00:00:00Z' }),
  argRow({ name: 'vm-a2', owner: 'platform', retiresOn: '2026-12-31T00:00:00Z' }),
  argRow({ name: 'vm-b1', owner: 'data', retiresOn: '2026-09-01T00:00:00Z' }),
  argRow({ name: 'vm-num', owner: 42 }),
  argRow({ name: 'vm-blank', owner: '   ' }),
  argRow({ name: 'vm-none' }),
];
const problemRows = [argRow({ name: 'vm-p1', owner: 'platform' })];

async function insertRule(id: string, marker: string, kind: 'state' | 'advisory', groupField: string | null): Promise<void> {
  await execRun(db.insert(rulesTable).values({
    id, name: id, description: 'rule recommendation', category: 'security', severity: 'high', enabled: true,
    scope: JSON.stringify({ level: 'subscription' }), resourceTypes: JSON.stringify([]),
    conditions: JSON.stringify([]),
    rawKql: `resources | where type == "microsoft.compute/virtualmachines" ${marker}`,
    type: 'custom', kind, groupField, deadlineField: kind === 'advisory' ? 'retiresOn' : null,
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

const advisories = () => buildExplorerData({ kinds: ['advisory'], now: NOW });
const byName = <T extends { resourceName?: string }>(list: T[], name: string): T => list.find(f => f.resourceName === name)!;

beforeEach(async () => {
  await resetDb();
  await clearRules();
  mockAuth.mockReset();
  advisoryResult = advisoryRows;
  const viewer = await createUser({ email: 'viewer@example.com', role: 'viewer' });
  if ('error' in viewer) throw new Error(viewer.error);
  mockAuth.mockResolvedValue({ user: { uid: viewer.user.id } });
  await insertRule(PROBLEM, P_MARK, 'state', 'owner');
  await insertRule(ADVISORY, A_MARK, 'advisory', 'owner');
});

describe('the group value of an Advisory finding', () => {
  it('is read from the Group column, trimmed, and none for a blank or missing value', async () => {
    await scan();
    const { findings } = await advisories();
    const value = (name: string) => byName(findings, name).groupValue;
    expect(value('vm-a1')).toBe('platform');
    expect(value('vm-a2')).toBe('platform');
    expect(value('vm-b1')).toBe('data');
    expect(value('vm-num')).toBe('42');
    expect(value('vm-blank')).toBeUndefined();
    expect(value('vm-none')).toBeUndefined();
  });

  it('is not read for a Problem rule, even one that holds a Group column', async () => {
    await scan();
    const problem = (await listFindings()).filter(f => f.ruleId === PROBLEM);
    expect(problem).toHaveLength(1);
    expect(problem[0].groupValue).toBeUndefined();
  });

  it('follows the next sighting: a changed value replaces the old one, a missing one clears it', async () => {
    await scan();
    advisoryResult = () => [
      argRow({ name: 'vm-a1', owner: 'security' }),
      argRow({ name: 'vm-a2' }),
    ];
    await scan();
    const found = (await listFindings()).filter(f => f.ruleId === ADVISORY);
    expect(byName(found, 'vm-a1').groupValue).toBe('security');
    expect(byName(found, 'vm-a2').groupValue).toBeUndefined();
  });

  it('is kept, with the column, across a switch to Problem and back', async () => {
    await updateRule(ADVISORY, { kind: 'state' });
    expect((await loadRules()).find(r => r.id === ADVISORY)?.groupField).toBe('owner');
    await scan();
    expect((await listFindings()).filter(f => f.ruleId === ADVISORY).every(f => f.groupValue === undefined)).toBe(true);
    await updateRule(ADVISORY, { kind: 'advisory' });
    await scan();
    expect(byName((await advisories()).findings, 'vm-a1').groupValue).toBe('platform');
  });

  it('is none for every finding of a rule with no Group column', async () => {
    await updateRule(ADVISORY, { groupField: undefined });
    await scan();
    const { findings } = await advisories();
    expect(findings).toHaveLength(6);
    expect(findings.every(f => f.groupValue === undefined)).toBe(true);
    const groups = groupAdvisories(findings);
    expect(groups).toHaveLength(1);
    expect(groups[0].groups).toHaveLength(1);
    expect(groups[0].hasNamedGroups).toBe(false);
  });
});

describe('grouping the Advisories read model', () => {
  it('builds one rule section with a group per value, and the rule recommendation once per group', async () => {
    await scan();
    const [rule, ...rest] = groupAdvisories((await advisories()).findings);
    expect(rest).toEqual([]);
    expect(rule.ruleId).toBe(ADVISORY);
    expect(rule.groups.map(g => g.groupValue)).toEqual(['platform', 'data', '42', undefined]);
    expect(rule.groups.map(g => g.findings.length)).toEqual([2, 1, 1, 2]);
    expect(rule.groups.every(g => g.recommendation === 'rule recommendation')).toBe(true);
  });

  it('puts an Overdue group first and orders members by urgency', async () => {
    await scan();
    const [rule] = groupAdvisories((await advisories()).findings);
    expect(rule.groups[0].groupValue).toBe('platform');
    expect(rule.groups[0].findings.map(f => f.resourceName)).toEqual(['vm-a1', 'vm-a2']);
    expect(rule.groups[0].overdueCount).toBe(1);
  });

  it('changes no count: the members add up to the listing, and the tiles and posture are untouched', async () => {
    await scan();
    const { findings } = await advisories();
    const groups = groupAdvisories(findings);
    expect(groups.flatMap(r => r.groups.flatMap(g => g.findings))).toHaveLength(findings.length);
    expect(groups[0].openCount).toBe(findings.length);
    expect(summarizeFindings(findings, WINDOW.from, WINDOW.to, ['advisory']).total).toBe(6);
    const summary = await computeWidgetSummary({ categories: ['security'], dateWindow: { mode: 'relative', days: 7 } }, 30);
    expect(summary.current.activeFindings).toBe(1);
  });

  it('keeps every fingerprint unchanged by the group column', async () => {
    await scan();
    const before = (await listFindings()).filter(f => f.ruleId === ADVISORY).map(f => f.fingerprint).sort();
    await updateRule(ADVISORY, { groupField: undefined });
    await scan();
    const after = (await listFindings()).filter(f => f.ruleId === ADVISORY).map(f => f.fingerprint).sort();
    expect(after).toEqual(before);
  });

  it('resolves only the one Advisory when a resource in a group is fixed', async () => {
    await scan();
    advisoryResult = () => advisoryRows().filter(r => r.name !== 'vm-a1');
    await scan();
    const { findings } = await advisories();
    expect(byName(findings, 'vm-a1').status).toBe('fixed');
    expect(byName(findings, 'vm-a2').status).toBe('active');
    expect(findings.filter(f => f.status === 'fixed')).toHaveLength(1);
    const platform = groupAdvisories(findings)[0].groups.find(g => g.groupValue === 'platform')!;
    expect(platform.findings).toHaveLength(2);
    expect(platform.openCount).toBe(1);
  });
});
