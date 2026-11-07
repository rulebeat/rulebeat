/**
 * #387: the words the Scans filter chips and empty lists use for the Scope, Rule source and First seen
 * filters, and for values that are missing or outside the viewer's Access. The server works out each
 * value's state; these are the functions the explorer draws them through.
 */
import { describe, expect, it } from 'vitest';
import {
  NO_FILTER_STATES, ageChipLabel, dimensionMatchingNothing, dropValues, markedLabel, scopeChips, sourceLabel,
  type FilterStates, type ScopePickState,
} from '@/lib/filter-states';
import { emptyListCopy, emptyReasonOf, filterValueLabel } from '@/lib/explorer-screen';
import type { ViewFilter } from '@/lib/finding-view';

const pick = (value: string, access: ScopePickState['access'], label: string | null = null): ScopePickState => ({ value, access, label });
const states = (extra: Partial<FilterStates>): FilterStates => ({ ...NO_FILTER_STATES, ...extra });

describe('ageChipLabel', () => {
  it('reads "First seen 31 to 90 days ago"', () => {
    expect(ageChipLabel({ min: 31, max: 90 })).toBe('First seen 31 to 90 days ago');
  });

  it('reads an open end, a single day and day one in the singular', () => {
    expect(ageChipLabel({ min: 31, max: null })).toBe('First seen 31 days ago or more');
    expect(ageChipLabel({ min: 7, max: 7 })).toBe('First seen 7 days ago');
    expect(ageChipLabel({ min: 1, max: 1 })).toBe('First seen 1 day ago');
    expect(ageChipLabel({ min: 0, max: 1 })).toBe('First seen 0 to 1 day ago');
  });
});

describe('scopeChips', () => {
  it('names a held pick, and a partly held subscription with a note', () => {
    expect(scopeChips([pick('/a', 'held', 'Sub A'), pick('/b', 'narrowed', 'Sub B')])).toEqual([
      { key: '/a', label: 'Sub A', values: ['/a'] },
      { key: '/b', label: 'Sub B (narrowed to what you hold)', values: ['/b'] },
    ]);
  });

  it('counts the picks with no held part in one chip and never names them', () => {
    const chips = scopeChips([pick('/secret-one', 'outside'), pick('/secret-two', 'outside')]);
    expect(chips).toEqual([{ key: 'outside', label: '2 Scopes outside your access', values: ['/secret-one', '/secret-two'] }]);
    expect(JSON.stringify(chips.map(c => c.label))).not.toContain('secret');
  });

  it('reads one such pick in the singular', () => {
    expect(scopeChips([pick('/x', 'outside')])[0]!.label).toBe('1 Scope outside your access');
  });

  it('counts a partly held pick the viewer may not read, with the note', () => {
    expect(scopeChips([pick('/g', 'outside-narrowed')])).toEqual([
      { key: 'outside-narrowed', label: '1 Scope outside your access, narrowed to what you hold', values: ['/g'] },
    ]);
    expect(scopeChips([pick('/g', 'outside-narrowed'), pick('/h', 'outside-narrowed')])[0]!.label)
      .toBe('2 Scopes outside your access, narrowed to what you hold');
  });

  it('keeps the held ones first and each class apart', () => {
    const chips = scopeChips([pick('/o', 'outside'), pick('/a', 'held', 'Sub A'), pick('/g', 'outside-narrowed')]);
    expect(chips.map(c => c.key)).toEqual(['/a', 'outside', 'outside-narrowed']);
  });

  it('is empty without picks', () => {
    expect(scopeChips([])).toEqual([]);
  });
});

describe('source and marks', () => {
  it('names Community and Custom, a pack by its label and an unknown pack by its id', () => {
    expect(sourceLabel('community')).toBe('Community');
    expect(sourceLabel('custom')).toBe('Custom');
    expect(sourceLabel('rulebeat-core')).toBe('RuleBeat Core');
    expect(sourceLabel('aprl-v2')).toBe('APRL v2');
    expect(sourceLabel('gone-pack')).toBe('gone-pack');
  });

  it('marks a name with a note after it', () => {
    expect(markedLabel('gone-pack', 'no longer exists')).toBe('gone-pack (no longer exists)');
  });
});

describe('dropValues', () => {
  it('drops the values named, ignoring case, and is undefined when none is left', () => {
    expect(dropValues(['/a', '/B', '/c'], ['/b'])).toEqual(['/a', '/c']);
    expect(dropValues(['/a'], ['/A'])).toBeUndefined();
    expect(dropValues(undefined, ['/a'])).toBeUndefined();
    expect(dropValues(['/a'], [])).toEqual(['/a']);
  });
});

describe('filterValueLabel', () => {
  const named = (value: string) => `named ${value}`;

  it('marks a tag no rule carries as no longer existing, and a deleted category as deleted', () => {
    const s = states({ missingTags: ['old-tag'], deletedCategories: ['old-cat'] });
    expect(filterValueLabel('tags', 'old-tag', undefined, s, named)).toBe('named old-tag (no longer exists)');
    expect(filterValueLabel('category', 'old-cat', undefined, s, named)).toBe('named old-cat (deleted)');
  });

  it('leaves every other value as it was named', () => {
    const s = states({ missingTags: ['old-tag'], deletedCategories: ['old-cat'] });
    expect(filterValueLabel('tags', 'live-tag', undefined, s, named)).toBe('named live-tag');
    expect(filterValueLabel('category', 'live-cat', undefined, s, named)).toBe('named live-cat');
    expect(filterValueLabel('severity', 'old-tag', undefined, s, named)).toBe('named old-tag');
    expect(filterValueLabel('tags', 'old-tag', undefined, undefined, named)).toBe('named old-tag');
  });

  it('still reads "Outside your access" for a marked subscription', () => {
    expect(filterValueLabel('subscription', 'sub', { subscriptions: ['sub'], resourceGroups: [] }, undefined, named)).toBe('Outside your access');
  });
});

describe('dimensionMatchingNothing', () => {
  it('names the Scope filter when every pick is outside the Access, or the set could not be opened', () => {
    expect(dimensionMatchingNothing(states({ scope: [pick('/a', 'outside'), pick('/b', 'outside')] }), 0)).toBe('scope-outside');
    expect(dimensionMatchingNothing(states({ scopeUnresolved: true }), 0)).toBe('scope-unresolved');
  });

  it('does not, while any pick has a held part', () => {
    expect(dimensionMatchingNothing(states({ scope: [pick('/a', 'outside'), pick('/b', 'held', 'B')] }), 0)).toBeNull();
    expect(dimensionMatchingNothing(states({ scope: [pick('/a', 'outside-narrowed')] }), 0)).toBeNull();
  });

  it('names Rule source when no pack in it exists, and tags when none is carried', () => {
    const gone = { value: 'gone', label: 'gone', exists: false };
    expect(dimensionMatchingNothing(states({ source: [gone] }), 0)).toBe('source');
    expect(dimensionMatchingNothing(states({ source: [gone, { value: 'custom', label: 'Custom', exists: true }] }), 0)).toBeNull();
    expect(dimensionMatchingNothing(states({ missingTags: ['a', 'b'] }), 2)).toBe('tags');
    expect(dimensionMatchingNothing(states({ missingTags: ['a'] }), 2)).toBeNull();
  });

  it('names nothing for a deleted category, which still matches its findings', () => {
    expect(dimensionMatchingNothing(states({ deletedCategories: ['old'] }), 0)).toBeNull();
  });
});

describe('an empty list says why', () => {
  const filter = (field: ViewFilter['field'], ...values: string[]) => ({ field, values }) as ViewFilter;

  it('uses the reason of the dimension that matches nothing', () => {
    const gone = { value: 'gone', label: 'gone', exists: false };
    expect(emptyReasonOf({ filters: [], outsideAccess: undefined, filterStates: states({ scope: [pick('/a', 'outside')] }) })).toBe('scope-outside');
    expect(emptyReasonOf({ filters: [], outsideAccess: undefined, filterStates: states({ scopeUnresolved: true }) })).toBe('scope-unresolved');
    expect(emptyReasonOf({ filters: [], outsideAccess: undefined, filterStates: states({ source: [gone] }) })).toBe('source');
    expect(emptyReasonOf({ filters: [filter('tags', 'a')], outsideAccess: undefined, filterStates: states({ missingTags: ['a'] }) })).toBe('tags');
  });

  it('keeps the ordinary reason when something can still match', () => {
    expect(emptyReasonOf({ filters: [filter('tags', 'a', 'b')], outsideAccess: undefined, filterStates: states({ missingTags: ['a'] }) })).toBe('filters');
    expect(emptyReasonOf({ filters: [], outsideAccess: undefined, filterStates: NO_FILTER_STATES })).toBe('filters');
  });

  it('has words of its own for each, not the genuinely-empty copy', () => {
    for (const reason of ['scope-outside', 'scope-unresolved', 'source', 'tags'] as const) {
      const copy = emptyListCopy(reason, 'findings');
      expect(copy).not.toBe(emptyListCopy('filters', 'findings'));
      expect(copy).toContain('no findings can be listed');
    }
    expect(emptyListCopy('scope-outside', 'rules')).toContain('no rules can be listed');
    expect(emptyListCopy('scope-outside', 'findings')).toContain('outside your Access');
    expect(emptyListCopy('source', 'findings')).toContain('no longer');
    expect(emptyListCopy('tags', 'findings')).toContain('no longer');
  });
});

describe('sourceLabel with a manifest', () => {
  it('takes the manifest\'s label before the built-in one, and the id when neither has one', () => {
    expect(sourceLabel('aprl-v2')).toBe('APRL v2');
    expect(sourceLabel('aprl-v2', { 'aprl-v2': { label: 'From the manifest' } })).toBe('From the manifest');
    expect(sourceLabel('zzz-pack', { 'aprl-v2': { label: 'x' } })).toBe('zzz-pack');
    expect(sourceLabel('community', { community: { label: 'ignored' } })).toBe('Community');
  });
});
