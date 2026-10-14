/**
 * #274: which empty state the explorer shows, and what a filter chip reads, for a filter that names
 * something outside the person's access.
 */
import { describe, expect, it } from 'vitest';
import { emptyListCopy, emptyReasonOf, filterChipLabel } from '@/lib/explorer-screen';
import type { ViewFilter } from '@/lib/finding-view';
import { OUTSIDE_ACCESS_LABEL } from '@/lib/outside-access';

const SUB_ONE = '00000000-0000-0000-0000-00000000000a';
const SUB_TWO = '00000000-0000-0000-0000-00000000000b';
const marks = { subscriptions: [SUB_TWO], resourceGroups: ['rg-two'] };
const filter = (field: ViewFilter['field'], ...values: string[]) => ({ field, op: 'is', values }) as unknown as ViewFilter;

describe('emptyReasonOf', () => {
  it('names access for a person with no Scope', () => {
    expect(emptyReasonOf({ noAccess: true, filters: [], outsideAccess: undefined })).toBe('access');
  });

  it('names access when every subscription value is outside, or every resource group value is', () => {
    expect(emptyReasonOf({ filters: [filter('subscription', SUB_TWO)], outsideAccess: marks })).toBe('access');
    expect(emptyReasonOf({ filters: [filter('resourceGroup', 'rg-two')], outsideAccess: marks })).toBe('access');
  });

  it('names the filters when one subscription value is inside, when none is set, and when nothing is marked', () => {
    expect(emptyReasonOf({ filters: [filter('subscription', SUB_TWO, SUB_ONE)], outsideAccess: marks })).toBe('filters');
    expect(emptyReasonOf({ filters: [], outsideAccess: marks })).toBe('filters');
    expect(emptyReasonOf({ filters: [filter('subscription', SUB_TWO)], outsideAccess: { subscriptions: [], resourceGroups: [] } })).toBe('filters');
    expect(emptyReasonOf({ filters: [filter('severity', 'high')], outsideAccess: marks })).toBe('filters');
  });
});

describe('emptyListCopy', () => {
  it('keeps the ordinary copy for filters and names access otherwise', () => {
    expect(emptyListCopy('filters', 'findings')).toBe('No findings match your filters');
    expect(emptyListCopy('filters', 'rules')).toBe('No rules match your filters');
    expect(emptyListCopy('access', 'findings')).toContain('outside your Access');
    expect(emptyListCopy('access', 'findings')).not.toContain('match your filters');
  });
});

describe('filterChipLabel', () => {
  const named = (value: string) => `named ${value}`;

  it('reads "Outside your access" for a marked subscription or resource group, with neither id nor name', () => {
    expect(filterChipLabel('subscription', SUB_TWO, marks, named)).toBe(OUTSIDE_ACCESS_LABEL);
    expect(filterChipLabel('resourceGroup', 'rg-two', marks, named)).toBe(OUTSIDE_ACCESS_LABEL);
  });

  it('reads the name for a value inside, and for every other field', () => {
    expect(filterChipLabel('subscription', SUB_ONE, marks, named)).toBe(`named ${SUB_ONE}`);
    expect(filterChipLabel('severity', SUB_TWO, marks, named)).toBe(`named ${SUB_TWO}`);
    expect(filterChipLabel('subscription', SUB_TWO, undefined, named)).toBe(`named ${SUB_TWO}`);
  });
});
