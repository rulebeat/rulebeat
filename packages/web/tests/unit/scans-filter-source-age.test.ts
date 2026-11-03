/**
 * #387: the Rule source, rule tags, category and First seen (age) filters on the Results, Advisories and
 * Activity tabs, and how each value of those filters is told apart when it is missing. Driven through the
 * view reads the routes call, over findings stored by the real findings sync and rules written through
 * the rules repository. Every id is fake.
 *
 * Rules (what each is, for the Rule source filter):
 *   core-rule      a built-in with no pack: RuleBeat Core
 *   aprl-rule      a built-in in the aprl-v2 pack, tagged `framework:iso`
 *   aprl-retired   a built-in in aprl-v2 that no pack ships any more: it keeps its pack
 *   community-rule a community rule, tagged `community-only`
 *   custom-rule    a custom rule
 *   (a copy)       a copy of core-rule, made by the real duplicate: a custom rule
 *   (a Personal rule) has no row in `rules`, so it is no source
 * The findings are named after their rules, one each, plus `orphan` (a rule that is no row at all).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';
import { EVERYTHING_ACCESS } from '../helpers/access';
import { createUser } from '@/lib/db/users';
import { createPersonalRule } from '@/lib/db/personal-rules';
import { createCategory, deleteCategory } from '@/lib/db/categories';
import { duplicateRule, saveRules } from '@/lib/rules';
import { openExport, queryColumnValues, queryGroup, queryView } from '@/lib/db/finding-views';
import { streamExport } from '@/lib/export-stream';
import { emptyView, type View } from '@/lib/finding-view';
import type { ViewTab } from '@/lib/view-response';
import type { Rule } from '@rulebeat/core';

const ruleRow = (id: string, extra: Partial<Rule>): Rule => ({
  id, name: id, description: 'a rule', category: 'security', severity: 'high', enabled: true, type: 'custom',
  scope: { level: 'subscription' }, resourceTypes: [], conditions: [], rawKql: 'resources | project id', ...extra,
} as Rule);

const NOW = new Date('2026-06-10T15:30:00.000Z');
const daysAgo = (n: number, time = '12:00:00.000Z') => {
  const day = new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return `${day}T${time}`;
};

let personalRuleId = '';
let copyRuleId = '';
let fingerprints: Record<string, string> = {};

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  await resetDb();
  await saveRules([
    ruleRow('core-rule', { type: 'builtin' }),
    ruleRow('aprl-rule', { type: 'builtin', pack: 'aprl-v2', tags: ['framework:iso'] }),
    ruleRow('aprl-retired', { type: 'builtin', pack: 'aprl-v2', retiredAt: '2026-05-01T00:00:00.000Z' }),
    ruleRow('community-rule', { type: 'community', tags: ['community-only'] }),
    ruleRow('custom-rule', { type: 'custom' }),
  ]);
  copyRuleId = (await duplicateRule('core-rule'))!.id;
  const author = await createUser({ email: 'author@example.com', role: 'editor' });
  if ('error' in author) throw new Error(author.error);
  personalRuleId = (await createPersonalRule(author.user.id, {
    name: 'a personal rule', description: 'd', category: 'security', severity: 'low', queryBackend: 'resource-graph', kind: 'state',
    scope: { level: 'subscription' }, resourceTypes: [], conditions: [], rawKql: 'resources',
  })).id;

  // Each finding is first seen when its scan finished, so the scans fix the ages.
  const at = (ruleId: string, extra: Record<string, unknown> = {}) => ({ ruleId, category: 'security', ...extra });
  await storeScan([
    syntheticFinding('core-rule', [{ n: 1 }], at('core-rule')),
    syntheticFinding('aprl-rule', [{ n: 1 }], at('aprl-rule', { severity: 'low' })),
    syntheticFinding('aprl-retired', [{ n: 1 }], at('aprl-retired')),
  ], { scanId: 'scan-day-0', finishedAt: daysAgo(0, '00:00:00.000Z') });
  await storeScan([
    syntheticFinding('community-rule', [{ n: 1 }], at('community-rule')),
    syntheticFinding('custom-rule', [{ n: 1 }], at('custom-rule')),
  ], { scanId: 'scan-day-31', finishedAt: daysAgo(31) });
  await storeScan([
    syntheticFinding('copy-rule', [{ n: 1 }], at(copyRuleId)),
    syntheticFinding('personal-rule', [{ n: 1 }], at(personalRuleId)),
  ], { scanId: 'scan-day-90', finishedAt: daysAgo(90, '23:59:59.000Z') });
  // Recorded under a category that is no row of `categories`, as a deleted category's findings are.
  await storeScan([
    syntheticFinding('orphan', [{ n: 1 }], at('no-such-rule', { category: 'gone-category' })),
  ], { scanId: 'scan-day-90-orphan', category: 'gone-category', finishedAt: daysAgo(90, '23:59:59.000Z') });
  await storeScan([
    syntheticFinding('advisory-aprl', [{ n: 1 }], at('aprl-rule', { kind: 'advisory' })),
    syntheticFinding('activity-community', [{ n: 1 }], at('community-rule', { placement: 'workspace', subscriptionId: 'sub-1', resourceGroup: 'rg-1' })),
  ], { scanId: 'scan-day-5', finishedAt: daysAgo(5), ranRuleIds: ['advisory-only-rule'] });
  const all = await queryView({ ...emptyView(), window: { mode: 'relative', days: 365 } }, { tab: 'results', showSuppressed: true }, EVERYTHING_ACCESS);
  fingerprints = Object.fromEntries(all.items.map(i => [i.finding.resourceName!, i.finding.fingerprint]));
});

afterAll(() => vi.useRealTimers());

const query = (tab: ViewTab = 'results') => ({ tab, showSuppressed: true });
const read = (view: Partial<View>, tab: ViewTab = 'results') => queryView({ ...emptyView(), ...view }, query(tab), EVERYTHING_ACCESS);
const listed = async (view: Partial<View>, tab: ViewTab = 'results') =>
  (await read(view, tab)).items.map(i => i.finding.resourceName ?? i.finding.dimensionKey).sort();
const withSource = (...source: string[]) => ({ source });

describe('Rule source', () => {
  it('RuleBeat Core is every built-in with no pack', async () => {
    expect(await listed(withSource('rulebeat-core'))).toEqual(['core-rule']);
  });

  it('a pack matches its built-ins, a retired one included', async () => {
    expect(await listed(withSource('aprl-v2'))).toEqual(['aprl-retired', 'aprl-rule']);
  });

  it('Community matches community rules', async () => {
    expect(await listed(withSource('community'))).toEqual(['community-rule']);
    expect(await listed(withSource('community'), 'activity')).toEqual(['activity-community']);
  });

  it('Custom matches custom rules, and a duplicate of a built-in is Custom', async () => {
    expect(await listed(withSource('custom'))).toEqual(['copy-rule', 'custom-rule']);
    expect(await listed(withSource('rulebeat-core'))).not.toContain('copy-rule');
  });

  it('Personal rules, and rules that are no row, never match', async () => {
    const everySource = ['rulebeat-core', 'aprl-v2', 'community', 'custom'];
    const matched = await listed(withSource(...everySource));
    expect(matched).not.toContain('personal-rule');
    expect(matched).not.toContain('orphan');
    expect(await listed(withSource('personal'))).toEqual([]);
  });

  it('several values are any-of, and the tab is the filter\'s own', async () => {
    expect(await listed(withSource('rulebeat-core', 'custom'))).toEqual(['copy-rule', 'core-rule', 'custom-rule']);
    expect(await listed(withSource('aprl-v2'), 'advisories')).toEqual(['advisory-aprl']);
  });

  it('reads the rule as it is now', async () => {
    // The finding was stored while the rule was custom; the filter reads the rule's current type.
    const stored = await read(withSource('custom'));
    expect(stored.items.map(i => i.finding.ruleId)).toContain('custom-rule');
  });

  it('is applied together with severity, as all-of across dimensions', async () => {
    const view = { ...withSource('aprl-v2'), filters: [{ field: 'severity' as const, values: ['low'] }] };
    expect(await listed(view)).toEqual(['aprl-rule']);
  });

  it('names each value, and marks a pack no rule carries, which matches nothing', async () => {
    const response = await read(withSource('rulebeat-core', 'aprl-v2', 'community', 'custom', 'gone-pack'));
    expect(response.filterStates.source).toEqual([
      { value: 'rulebeat-core', label: 'RuleBeat Core', exists: true },
      { value: 'aprl-v2', label: 'APRL v2', exists: true },
      { value: 'community', label: 'Community', exists: true },
      { value: 'custom', label: 'Custom', exists: true },
      { value: 'gone-pack', label: 'gone-pack', exists: false },
    ]);
    expect(await listed(withSource('gone-pack'))).toEqual([]);
  });
});

describe('rule tags and category', () => {
  it('rule tags read the current rule', async () => {
    expect(await listed({ filters: [{ field: 'tags', values: ['framework:iso'] }] })).toEqual(['aprl-rule']);
  });

  it('a tag no rule carries is marked and matches nothing', async () => {
    const view = { filters: [{ field: 'tags' as const, values: ['framework:iso', 'retired-tag'] }] };
    const response = await read(view);
    expect(response.filterStates.missingTags).toEqual(['retired-tag']);
    expect(response.items.map(i => i.finding.resourceName)).toEqual(['aprl-rule']);
    expect(await listed({ filters: [{ field: 'tags', values: ['retired-tag'] }] })).toEqual([]);
  });

  it('a deleted category is marked but still matches the findings recorded under it', async () => {
    const view = { filters: [{ field: 'category' as const, values: ['gone-category', 'security'] }] };
    const response = await read(view);
    expect(response.filterStates.deletedCategories).toEqual(['gone-category']);
    expect(response.items.map(i => i.finding.resourceName)).toContain('orphan');
    expect(await listed({ filters: [{ field: 'category', values: ['gone-category'] }] })).toEqual(['orphan']);
  });

  it('a category deleted after findings were recorded under it is marked, and one that exists is not', async () => {
    const created = await createCategory({ label: 'Short lived' });
    if ('error' in created) throw new Error(created.error);
    const id = created.category.id;
    expect((await read({ filters: [{ field: 'category', values: [id] }] })).filterStates.deletedCategories).toEqual([]);
    await deleteCategory(id);
    expect((await read({ filters: [{ field: 'category', values: [id] }] })).filterStates.deletedCategories).toEqual([id]);
  });

  it('says nothing about filters that name nothing missing', async () => {
    const response = await read({ filters: [{ field: 'tags', values: ['framework:iso'] }, { field: 'category', values: ['security'] }] });
    expect([response.filterStates.missingTags, response.filterStates.deletedCategories, response.filterStates.source]).toEqual([[], [], []]);
  });
});

describe('First seen age', () => {
  const ageOf = (min: number, max: number | null) => ({ age: { min, max } });
  const WITH_FINDINGS_AT_0 = ['aprl-retired', 'aprl-rule', 'core-rule'];

  it('is whole UTC days since the finding was first seen, from MIN to MAX inclusive', async () => {
    expect(await listed(ageOf(0, 0))).toEqual(WITH_FINDINGS_AT_0);
    expect(await listed(ageOf(31, 31))).toEqual(['community-rule', 'custom-rule']);
    expect(await listed(ageOf(31, 90))).toEqual(['community-rule', 'copy-rule', 'custom-rule', 'orphan', 'personal-rule']);
    expect(await listed(ageOf(32, 89))).toEqual([]);
  });

  it('counts the calendar day in UTC, whatever the time of day the finding was first seen at', async () => {
    // 90 days ago at 23:59:59 is still 90 days ago, though it is nearly 89 days of elapsed time.
    expect(await listed(ageOf(90, 90))).toEqual(['copy-rule', 'orphan', 'personal-rule']);
    expect(await listed(ageOf(89, 89))).toEqual([]);
  });

  it('is open ended without a MAX', async () => {
    expect(await listed(ageOf(31, null))).toEqual(['community-rule', 'copy-rule', 'custom-rule', 'orphan', 'personal-rule']);
    expect(await listed(ageOf(91, null))).toEqual([]);
  });

  it('is resolved on read, so it rolls with the date', async () => {
    vi.setSystemTime(new Date(NOW.getTime() + 24 * 60 * 60 * 1000));
    try {
      expect(await listed(ageOf(0, 0))).toEqual([]);
      expect(await listed(ageOf(1, 1))).toEqual(WITH_FINDINGS_AT_0);
    } finally {
      vi.setSystemTime(NOW);
    }
  });

  it('reads the Advisories and Activity tabs too', async () => {
    expect(await listed(ageOf(5, 5), 'advisories')).toEqual(['advisory-aprl']);
    expect(await listed(ageOf(0, 4), 'advisories')).toEqual([]);
    expect(await listed(ageOf(0, 30), 'activity')).toEqual(['activity-community']);
  });

  it('is independent of the window, the status and the First seen funnel, each applying all-of', async () => {
    // A 1 day window makes "new" mean first seen today; the age is not the window.
    const oneDay = { window: { mode: 'relative' as const, days: 1 } };
    expect(await listed({ ...ageOf(31, 90), ...oneDay })).toEqual(['community-rule', 'copy-rule', 'custom-rule', 'orphan', 'personal-rule']);
    expect(await listed({ ...ageOf(31, 90), filters: [{ field: 'status', values: ['new'] }], ...oneDay })).toEqual([]);
    const day31 = daysAgo(31).slice(0, 10);
    expect(await listed({ ...ageOf(31, 90), filters: [{ field: 'firstSeen', values: [day31] }] })).toEqual(['community-rule', 'custom-rule']);
    expect(await listed({ ...ageOf(0, 30), filters: [{ field: 'firstSeen', values: [day31] }] })).toEqual([]);
  });

  it('is applied together with the Rule source and the Scope, all-of', async () => {
    expect(await listed({ ...ageOf(31, 90), ...withSource('custom') })).toEqual(['copy-rule', 'custom-rule']);
    expect(await listed({ ...ageOf(0, 0), ...withSource('custom') })).toEqual([]);
    expect(await listed({ ...ageOf(0, 0), scope: ['/subscriptions/sub-1'] })).toEqual(WITH_FINDINGS_AT_0);
  });

  it('a view with age null (Any) and one without are the same', async () => {
    expect(await listed({ age: null })).toEqual(await listed({}));
  });
});

describe('the same filters on the group, column values and export reads', () => {
  it('narrow a group, a column\'s values and an export', async () => {
    const view: View = { ...emptyView(), source: ['custom'], age: { min: 31, max: 90 }, groupBy: ['category'] };
    const opened = await queryGroup(view, { ...query(), groupPath: ['security'], groupPage: 1 }, EVERYTHING_ACCESS);
    expect(opened.items.map(i => i.finding.resourceName).sort()).toEqual(['copy-rule', 'custom-rule']);

    const values = await queryColumnValues({ ...emptyView(), source: ['rulebeat-core'] }, { ...query(), column: 'row.n' }, EVERYTHING_ACCESS);
    expect(values.values).toEqual([{ value: '1', count: 1 }]);

    const body = await new Response(await streamExport(openExport({ ...emptyView(), source: ['custom'] }, query(), EVERYTHING_ACCESS), 'json')).text();
    const exported = (JSON.parse(body) as { fingerprint: string }[]).map(f => f.fingerprint).sort();
    expect(exported).toEqual([fingerprints['copy-rule']!, fingerprints['custom-rule']!].sort());
  });
});
