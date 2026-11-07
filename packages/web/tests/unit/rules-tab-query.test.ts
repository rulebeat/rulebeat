/**
 * The Rules tab's address (#402): every filter the list reads is a param, the page and the client read
 * and write them with these two functions, and a link opens the list it describes.
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_RULES_QUERY, hasRulesFilter, rulesQueryFromSearchParams, rulesQueryToSearchParams, type RulesTabQuery,
} from '@/lib/rules-tab-query';

const read = (query: string) => rulesQueryFromSearchParams(new URLSearchParams(query));

describe('rulesQueryFromSearchParams', () => {
  it('reads an empty address as every rule: rules=all, no filter', () => {
    expect(read('tab=rules')).toEqual(EMPTY_RULES_QUERY);
    expect(EMPTY_RULES_QUERY.rules).toBe('all');
    expect(hasRulesFilter(EMPTY_RULES_QUERY)).toBe(false);
  });

  it('reads each parameter', () => {
    expect(read('category=security,network&source=aprl-v2,custom&tags=prod,pci&severity=critical,low' +
      '&subscription=sub-1,directory&rg=rg-one&managementGroup=mg-1&kind=advisory&outcome=failing&rules=enabled')).toEqual({
      categories: ['security', 'network'],
      sources: ['aprl-v2', 'custom'],
      tags: ['prod', 'pci'],
      severities: ['critical', 'low'],
      subscriptions: ['sub-1', 'directory'],
      resourceGroups: ['rg-one'],
      managementGroups: ['mg-1'],
      kind: 'advisory',
      outcome: 'failing',
      rules: 'enabled',
    });
  });

  it('reads every kind, outcome and rules value', () => {
    for (const kind of ['problem', 'advisory', 'activity']) expect(read(`kind=${kind}`).kind).toBe(kind);
    for (const outcome of ['passing', 'failing', 'unknown', 'checked']) expect(read(`outcome=${outcome}`).outcome).toBe(outcome);
    for (const rules of ['enabled', 'disabled', 'all']) expect(read(`rules=${rules}`).rules).toBe(rules);
  });

  it('ignores a value it does not know rather than rejecting the link', () => {
    const query = read('kind=state&outcome=healthy&rules=some&severity=critical,urgent&category=all&managementGroup=');
    expect(query).toEqual({ ...EMPTY_RULES_QUERY, severities: ['critical'] });
  });

  it('keeps a value that holds a comma, escaped the way the Scans views write it', () => {
    const query = read('tags=a\\,b,c');
    expect(query.tags).toEqual(['a,b', 'c']);
  });

  it('reads from the record Next.js hands a page', () => {
    expect(rulesQueryFromSearchParams({ rules: ['disabled', 'enabled'], kind: 'activity', tags: undefined })).toMatchObject({ rules: 'disabled', kind: 'activity', tags: [] });
  });
});

describe('rulesQueryToSearchParams', () => {
  const FULL: RulesTabQuery = {
    categories: ['security', 'network'], sources: ['rulebeat-core'], tags: ['a,b', 'c'], severities: ['high', 'info'],
    subscriptions: ['sub-1', 'directory'], resourceGroups: ['rg-one'], managementGroups: ['mg-1'],
    kind: 'problem', outcome: 'checked', rules: 'disabled',
  };

  it('writes nothing for the defaults, so a default list is a bare address', () => {
    expect(rulesQueryToSearchParams(EMPTY_RULES_QUERY).toString()).toBe('');
  });

  it('writes what it reads back, for every parameter', () => {
    expect(read(rulesQueryToSearchParams(FULL).toString())).toEqual(FULL);
  });

  it('is stable: reading what it wrote and writing it again changes nothing', () => {
    const once = rulesQueryToSearchParams(FULL).toString();
    expect(rulesQueryToSearchParams(read(once)).toString()).toBe(once);
  });

  it('keeps the params the page owns, and drops a rules param the new query no longer holds', () => {
    const base = new URLSearchParams('tab=rules&outcome=failing&kind=advisory&rules=enabled&view=abc');
    const next = rulesQueryToSearchParams({ ...EMPTY_RULES_QUERY, severities: ['high'] }, base);
    expect([...next]).toEqual([['tab', 'rules'], ['view', 'abc'], ['severity', 'high']]);
  });

  it('replaces a param it holds rather than repeating it', () => {
    const next = rulesQueryToSearchParams({ ...EMPTY_RULES_QUERY, rules: 'disabled' }, new URLSearchParams('tab=rules&rules=enabled'));
    expect(next.getAll('rules')).toEqual(['disabled']);
  });
});

describe('hasRulesFilter', () => {
  it('is true for each parameter alone', () => {
    const each: Partial<RulesTabQuery>[] = [
      { categories: ['x'] }, { sources: ['x'] }, { tags: ['x'] }, { severities: ['high'] }, { kind: 'problem' },
      { outcome: 'passing' }, { rules: 'enabled' },
    ];
    for (const part of each) expect(hasRulesFilter({ ...EMPTY_RULES_QUERY, ...part })).toBe(true);
  });

  it('does not count the Scope, which sets where the Outcome is read and hides no rule', () => {
    expect(hasRulesFilter({ ...EMPTY_RULES_QUERY, subscriptions: ['sub-1'], resourceGroups: ['rg'], managementGroups: ['mg'] })).toBe(false);
  });
});
