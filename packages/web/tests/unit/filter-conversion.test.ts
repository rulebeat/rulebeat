/**
 * The pure planner behind the upgrade of dashboard filters and saved views to Scope picks (ADR 0015): what
 * a query becomes when it is near the length limit, and what the plan emits for rows that need nothing.
 * The upgrade itself, on both backends, is db-migrations-filter-conversion.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { convertSavedViewQuery, indexPairs, planFilterConversion, resolveLegacyScope } from '@/lib/db/filter-conversion';
import { MAX_SAVED_VIEW_QUERY_LENGTH } from '@/lib/saved-view-query';

const sub = (n: number) => `20000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const NO_PAIRS = indexPairs([]);
const NOW = '2026-03-04T05:06:07.000Z';

describe('convertSavedViewQuery near the length limit', () => {
  it('keeps the legacy params beside a Scope set when the query still fits', () => {
    const subs = Array.from({ length: 90 }, (_, n) => sub(n)).join(',');
    const query = `subscription=${subs}&rg=rg-x`;
    expect(query.length).toBeGreaterThan(3000);

    const converted = convertSavedViewQuery(query, NO_PAIRS);

    if (converted === null || converted === 'too-long') throw new Error('expected a conversion');
    expect(converted.query.length).toBeLessThanOrEqual(MAX_SAVED_VIEW_QUERY_LENGTH);
    expect(converted.query.startsWith(query)).toBe(true);
    expect(new URLSearchParams(converted.query).get('scopeset')).toBe(converted.set!.hash);
    expect(converted.set!.paths).toHaveLength(90);
  });

  it('drops the legacy params, and only them, when keeping them would pass the limit', () => {
    const subs = Array.from({ length: 107 }, (_, n) => sub(n)).join(',');
    const query = `severity=high&subscription=${subs}&rg=rg-x`;
    expect(query.length).toBeGreaterThan(MAX_SAVED_VIEW_QUERY_LENGTH - 60);

    const converted = convertSavedViewQuery(query, NO_PAIRS);

    if (converted === null || converted === 'too-long') throw new Error('expected a conversion');
    expect(converted.query.length).toBeLessThanOrEqual(MAX_SAVED_VIEW_QUERY_LENGTH);
    const params = new URLSearchParams(converted.query);
    expect(params.has('subscription')).toBe(false);
    expect(params.has('rg')).toBe(false);
    expect(params.get('severity')).toBe('high');
    expect(params.has('scopeset')).toBe(true);
  });

  it('leaves a query alone, and says so, when no form of it fits', () => {
    const query = `q=${'x'.repeat(3990)}&subscription=${sub(1)}`;

    expect(convertSavedViewQuery(query, NO_PAIRS)).toBe('too-long');
    const plan = planFilterConversion({ dashboards: [], savedViews: [{ id: 'v', query }], pairs: [], now: NOW });
    expect(plan.statements).toEqual([]);
    expect(plan.skipped).toEqual([{ kind: 'saved view', id: 'v', reason: expect.stringContaining('4000') }]);
  });
});

describe('resolveLegacyScope', () => {
  it('never answers with an empty list for a non-empty filter', () => {
    for (const [subs, groups] of [[['directory'], []], [[], ['nowhere']], [['directory'], ['x']], [['a/b'], []]] as const) {
      const { paths, unresolved } = resolveLegacyScope(subs, groups, NO_PAIRS);
      expect(paths.length + unresolved.length).toBeGreaterThan(0);
    }
  });

  it('keeps a subscription id that is no Scope path as an unresolved pick instead of a path no set could hold', () => {
    expect(resolveLegacyScope(['a/b'], [], NO_PAIRS)).toEqual({ paths: [], unresolved: ['unresolved:a/b'] });
  });

  it('answers a pair once however many records and casings hold it', () => {
    const pairs = indexPairs([
      { subscription_id: 'S1', resource_group: 'Rg' }, { subscription_id: 's1', resource_group: 'rg' },
    ]);
    expect(resolveLegacyScope([], ['RG'], pairs).paths).toHaveLength(1);
  });
});

describe('planFilterConversion', () => {
  it('emits nothing for a dashboard and a saved view that need nothing', () => {
    const plan = planFilterConversion({
      dashboards: [{ id: 'd', config: JSON.stringify({ widgets: [] }) }],
      savedViews: [{ id: 'v', query: 'severity=high' }],
      pairs: [], now: NOW,
    });
    expect(plan).toEqual({ statements: [], skipped: [] });
  });

  it('writes the set before the row that names it', () => {
    const plan = planFilterConversion({
      dashboards: [{ id: 'd', config: JSON.stringify({ widgets: [], filters: { resourceGroups: ['wide'] } }) }],
      savedViews: [],
      pairs: Array.from({ length: 60 }, (_, n) => ({ subscription_id: sub(n), resource_group: 'wide' })),
      now: NOW,
    });
    expect(plan.statements.map(s => s.sql.split(' ')[0])).toEqual(['INSERT', 'UPDATE']);
    expect(plan.statements[0]!.params[2]).toBe(NOW);
  });
});

describe('convertSavedViewQuery keeps an unresolved pick visible', () => {
  const wide = indexPairs(Array.from({ length: 60 }, (_, n) => ({ subscription_id: sub(n), resource_group: 'rg-wide' })));

  it('holds the unresolved pick inside the set when a resolved list is long enough to become one', () => {
    const converted = convertSavedViewQuery('rg=rg-wide%2Crg-gone', wide);

    if (converted === null || converted === 'too-long') throw new Error('expected a conversion');
    expect(new URLSearchParams(converted.query).get('scopeset')).toBe(converted.set!.hash);
    expect(converted.set!.paths).toHaveLength(61);
    expect(converted.set!.paths).toContain('unresolved:resourceGroup/rg-gone');
  });

  it('makes a Scope set of an all-unresolved list over the inline budget instead of leaving a Scope that cannot be written', () => {
    const names = Array.from({ length: 80 }, (_, n) => `rg-missing-${String(n).padStart(3, '0')}`);

    for (const keepLegacy of [true, false]) {
      const converted = convertSavedViewQuery(`severity=high&rg=${names.join('%2C')}`, NO_PAIRS, keepLegacy);

      if (converted === null || converted === 'too-long') throw new Error('expected a conversion');
      const params = new URLSearchParams(converted.query);
      expect(params.get('scopeset')).toBe(converted.set!.hash);
      expect(converted.set!.paths).toEqual(names.map(n => `unresolved:resourceGroup/${n}`));
    }
  });
});
