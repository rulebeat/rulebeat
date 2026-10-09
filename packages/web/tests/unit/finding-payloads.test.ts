/**
 * ADR 0007, first step: nothing sends a finding's rows where no screen reads them. The /scans tabs
 * that do not show the explorer build no explorer data, the explorer receives each row once (rows,
 * not rows plus a copy of the first as evidence), and the dashboard feeds and filter lists never
 * read the stored row columns at all. Driven through a real scan over the fake Azure context.
 */
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeFingerprint } from '@rulebeat/core';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { findings as findingsTable, rules as rulesTable } from '@/lib/db/tables';
import { getCategory } from '@/lib/db/categories';
import { createUser } from '@/lib/db/users';
import { listFindings, listFindingSummaries } from '@/lib/db/findings';
import { runCategoryScan } from '@/lib/scan-runner';
import { buildExplorerData } from '@/lib/explorer-data';
import { clearRules, resetDb } from '../helpers/db';
import { argRow, fakeTenantContext } from '../helpers/fake-azure';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));
const recentFindings = await import('@/app/api/widgets/findings/route');
const filterOptions = await import('@/app/api/widgets/filter-options/route');
const { default: ScansPage } = await import('@/app/(app)/scans/page');

const RULE = 'payload-rule';
const ADVISORY = 'payload-advisory';
const VM = argRow({ name: 'vm-one' });
const VM_ID = String(VM.id);
const ROWS = [{ ...VM, retirement: 'a' }, { ...VM, retirement: 'b' }];

async function insertRule(id: string, kind: 'state' | 'advisory'): Promise<void> {
  await execRun(db.insert(rulesTable).values({
    id, name: id, description: 'test rule', category: 'security', severity: 'high', enabled: true,
    scope: JSON.stringify({ level: 'subscription' }), resourceTypes: JSON.stringify([]),
    conditions: JSON.stringify([]), rawKql: `resources | where type == "microsoft.compute/virtualmachines" // ${id}`,
    type: 'custom', kind,
  }));
}

/** Makes every stored row column unreadable, so any read path that parses one throws. */
async function corruptStoredRows(): Promise<void> {
  await execRun(db.update(findingsTable).set({ evidence: '{not json', evidenceRows: '[not json' }));
}

beforeEach(async () => {
  await resetDb();
  await clearRules();
  await insertRule(RULE, 'state');
  await insertRule(ADVISORY, 'advisory');
  const category = (await getCategory('security'))!;
  await runCategoryScan(category, { ctx: fakeTenantContext({ rows: ROWS }), ruleIds: [RULE, ADVISORY] });
  const viewer = await createUser({ email: 'viewer@example.com', role: 'viewer' });
  if ('error' in viewer) throw new Error(viewer.error);
  mockAuth.mockResolvedValue({ user: { uid: viewer.user.id } });
});

describe('the explorer payload', () => {
  it('carries every row once, with no separate copy of the first', async () => {
    const [finding] = (await buildExplorerData()).findings.filter(f => f.ruleId === RULE);
    expect(finding.fingerprint).toBe(computeFingerprint(RULE, VM_ID));
    expect(finding.rows.map(r => r.retirement)).toEqual(['a', 'b']);
    expect('evidence' in finding).toBe(false);
  });
});

describe('reads that never look at a row', () => {
  it('list the same findings without parsing the stored row columns', async () => {
    const withRows = await listFindings();
    await corruptStoredRows();
    const summaries = await listFindingSummaries();
    expect(summaries.map(f => f.fingerprint).sort()).toEqual(withRows.map(f => f.fingerprint).sort());
    expect(summaries.every(f => !('rows' in f) && !('evidence' in f))).toBe(true);
  });

  it('serve the recent findings feed without rows', async () => {
    await corruptStoredRows();
    const res = await recentFindings.GET(new Request('http://localhost/api/widgets/findings'));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>[];
    expect(body.map(f => f.ruleId)).toEqual([RULE]);
    expect(body.every(f => !('rows' in f) && !('evidence' in f))).toBe(true);
  });

  it('serve the dashboard filter lists without rows', async () => {
    await corruptStoredRows();
    const res = await filterOptions.GET();
    expect(res.status).toBe(200);
    const body = await res.json() as { rules: { id: string }[] };
    expect(body.rules.map(r => r.id).sort()).toEqual([ADVISORY, RULE].sort());
  });
});

/** The ScansClient element the page renders, found by the props only it takes. */
function scansClientProps(node: ReactNode): Record<string, unknown> {
  const queue: ReactNode[] = [node];
  while (queue.length > 0) {
    const next = queue.shift();
    if (Array.isArray(next)) { queue.push(...next); continue; }
    if (!isValidElement(next)) continue;
    const props = (next as ReactElement<Record<string, unknown>>).props;
    if ('activeTab' in props) return props;
    queue.push(props.children as ReactNode);
  }
  throw new Error('ScansClient not rendered');
}

describe('the /scans page', () => {
  const render = async (tab?: string) => scansClientProps(await ScansPage({ searchParams: Promise.resolve(tab ? { tab } : {}) }));

  it.each(['history', 'rules', 'schedules'])('builds no explorer data on the %s tab', async (tab) => {
    expect((await render(tab)).explorerData).toBeUndefined();
  });

  it('builds it for Results and Advisories, each with its own kinds', async () => {
    const results = (await render()).explorerData as { findings: { ruleId: string }[] };
    const advisories = (await render('advisories')).explorerData as { findings: { ruleId: string }[] };
    expect(results.findings.map(f => f.ruleId)).toEqual([RULE]);
    expect(advisories.findings.map(f => f.ruleId)).toEqual([ADVISORY]);
  });
});
