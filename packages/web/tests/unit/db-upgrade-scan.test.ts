/**
 * TS-25 · case 25-10 — running a scan after upgrading.
 *
 * Every other test in the upgrade suite inspects the database directly. This one goes through the
 * product: it upgrades a database that has a month of history in it, then runs a real scan over the
 * real code path with a fake Azure, and checks that the scan *continues* that history rather than
 * starting a new one.
 *
 * That distinction is the whole point. An upgrade that technically preserves every row but causes
 * the next scan to re-report the entire estate as brand new — resetting ages, breaking suppressions,
 * and making the "new findings" widgets spike — has failed the user just as badly as one that
 * deleted the rows.
 *
 * **Why this file is structured oddly.** `lib/db/client.ts` opens its connection and runs migrations
 * when it is *imported*, against whatever `RULEBEAT_DB_PATH` says at that moment. So the sample has
 * to be built and the variable repointed before anything pulls that module in — which means no
 * static import here may reach it, and everything that does must be imported dynamically inside
 * `beforeAll`. The static imports below are deliberately limited to test helpers and types.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { computeFingerprint } from '@rulebeat/core';
import { makeSample, upgradeInProcess } from '../fixtures/upgrade';
import { fakeTenantContext, argRow, TEST_SUB_A, type FakeTenantContext } from '../helpers/fake-azure';
import { ACTIVE_RESOURCE_ID, CUSTOM_RULES, FIXED_DATES, SUPPRESSED_RESOURCE_ID } from '../fixtures/populate';

// Module scope, before any dynamic import below: build a populated database in the previous
// version's shape, upgrade it, and point the app at it.
const sample = makeSample('pre-rbac');
upgradeInProcess(sample);
process.env.RULEBEAT_DB_PATH = sample.file;

/** The rule the pre-upgrade findings were recorded against. */
const RULE = CUSTOM_RULES[0];

type ScanRunner = typeof import('@/lib/scan-runner');
type RulesRepo = typeof import('@/lib/rules');
type FindingsRepo = typeof import('@/lib/db/findings');
type ScanHistory = typeof import('@/lib/scan-history');
type Categories = typeof import('@/lib/db/categories');

let scanRunner: ScanRunner;
let rules: RulesRepo;
let findings: FindingsRepo;
let history: ScanHistory;
let categories: Categories;

beforeAll(async () => {
  scanRunner = await import('@/lib/scan-runner');
  rules = await import('@/lib/rules');
  findings = await import('@/lib/db/findings');
  history = await import('@/lib/scan-history');
  categories = await import('@/lib/db/categories');
});

/** A scan of the upgraded database, returning every ARG query it issued along the way. */
async function scanWith(rows: Record<string, unknown>[]): Promise<FakeTenantContext> {
  const category = (await categories.listCategories()).find(c => c.id === RULE.category);
  expect(category, `category ${RULE.category} is missing after the upgrade`).toBeDefined();

  const ctx = fakeTenantContext({ rows, subscriptionIds: [TEST_SUB_A] });
  await scanRunner.runCategoryScan(category!, { ctx });
  return ctx;
}

describe('TS-25 · scanning after an upgrade', () => {
  it('25-10 · the upgraded rules still load and still generate their own KQL', async () => {
    const mine = (await rules.loadRules()).find(r => r.name === RULE.name);
    expect(mine, 'the custom rule did not survive the upgrade').toBeDefined();
    expect(mine!.rawKql, 'the rule would now ask Azure a different question').toBe(RULE.rawKql);
    expect(mine!.enabled).toBe(true);
  });

  it('25-10 · a scan runs and issues the migrated rule\'s query unchanged', async () => {
    const ctx = await scanWith([]);
    expect(ctx.queries.length, 'the scan issued no queries at all').toBeGreaterThan(0);
    expect(
      ctx.queries.some(q => q.kql === RULE.rawKql),
      'no query matched the rule as the user wrote it',
    ).toBe(true);
  });

  it('25-10 · pre-upgrade scan history is added to, not replaced', async () => {
    // The fixture's history was recorded against a different category than the one being scanned,
    // which is the point: a new scan must not disturb history it has nothing to do with.
    const otherCategoryBefore = (await history.listScanMetas('cost')).length;
    expect(otherCategoryBefore, 'history from before the upgrade was dropped').toBeGreaterThan(0);

    const before = (await history.listScanMetas(RULE.category)).length;
    await scanWith([]);

    expect((await history.listScanMetas(RULE.category)).length, 'the new scan did not record a run').toBe(before + 1);
    expect((await history.listScanMetas('cost')).length, 'the scan clobbered unrelated history').toBe(otherCategoryBefore);
  });

  it('25-10 · a finding that still exists keeps its age and its count', async () => {
    const before = (await findings.listFindings()).find(f => f.resourceId === ACTIVE_RESOURCE_ID);
    expect(before, 'the pre-upgrade finding is missing').toBeDefined();
    const timesSeenBefore = before!.timesSeen;

    await scanWith([argRow({ id: ACTIVE_RESOURCE_ID, name: 'vm-legacy-01' })]);

    const matching = (await findings.listFindings()).filter(f => f.resourceId === ACTIVE_RESOURCE_ID);
    // One row, not two. A second row for the same resource means the scan failed to recognise its
    // own finding — which is what happens if the fingerprint it computes no longer matches the one
    // on disk.
    expect(matching.length, 'the same violation was recorded twice').toBe(1);
    expect(matching[0]!.firstSeenAt, 'the finding was aged back to today').toBe(FIXED_DATES.firstSeen);
    expect(matching[0]!.timesSeen, 'the repeat count restarted').toBe(timesSeenBefore + 1);
    expect(matching[0]!.status).toBe('active');
  });

  it('25-10 · the fingerprint a scan computes matches the one stored before the upgrade', async () => {
    // Stated directly, because it underpins the test above and every suppression in the product:
    // findings are keyed by sha256(ruleId::resourceId), recomputed on every scan. If an upgrade
    // rewrites a rule's id, every fingerprint derived from it silently stops matching.
    const rule = (await rules.loadRules()).find(r => r.name === RULE.name)!;
    const stored = (await findings.listFindings()).find(f => f.resourceId === ACTIVE_RESOURCE_ID);
    expect(stored).toBeDefined();
    expect(computeFingerprint(rule.id, ACTIVE_RESOURCE_ID)).toBe(stored!.fingerprint);
  });

  it('25-10 · a suppressed finding is still suppressed after a real scan', async () => {
    await scanWith([
      argRow({ id: ACTIVE_RESOURCE_ID, name: 'vm-legacy-01' }),
      argRow({ id: SUPPRESSED_RESOURCE_ID, name: 'stlegacy001' }),
    ]);

    const rule = (await rules.loadRules()).find(r => r.name === RULE.name)!;
    const suppressedFingerprint = computeFingerprint(rule.id, SUPPRESSED_RESOURCE_ID);
    const { loadSuppressions } = await import('@/lib/suppressions');
    const active = (await loadSuppressions()).map(s => s.fingerprint);

    expect(
      active.includes(suppressedFingerprint),
      'the accepted risk would start being reported again after the upgrade',
    ).toBe(true);
  });
});
