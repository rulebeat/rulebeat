/**
 * What the explorer decides to draw, pinned without rendering it: which screen it shows for what the
 * session holds, what stands in for the list, when a group or a dropdown reads, and what a dropdown
 * of values shows. The component only draws the answer of these, so a branch that is wrong here is
 * wrong on screen. Failure comes before empty in every one: a read that failed is never "no findings".
 */
import { describe, expect, it } from 'vitest';
import { emptyView, rowField } from '@/lib/finding-view';
import { groupUrl, type Loaded, type ViewRequest } from '@/lib/explorer-session';
import { listBodyOf, openGroupUrl, screenOf, valueOptionsOf, valuesPanelOf } from '@/lib/explorer-screen';
import type { ColumnValuesResponse } from '@/lib/view-response';

const request: ViewRequest = { view: { ...emptyView(), groupBy: ['category', rowField('zone')] }, tab: 'results', showSuppressed: false };

const answered = (policyOptions: number) => ({ policyOptions: Array.from({ length: policyOptions }, (_, i) => ({ id: `r${i}`, name: `Rule ${i}`, category: 'security' })) });

describe('which screen the explorer shows', () => {
  it('shows the widget as unavailable when its suppressions failed, before anything else', () => {
    for (const data of [null, answered(0), answered(2)]) {
      for (const failure of [null, 'Could not load the findings.']) {
        expect(screenOf({ mode: 'widget', suppressionsFailed: true, failure, data })).toBe('widget-unavailable');
      }
    }
  });

  it('ignores a failed suppressions load on the page, which is always given them', () => {
    expect(screenOf({ mode: 'page', suppressionsFailed: true, failure: null, data: answered(2) })).toBe('explorer');
  });

  it('shows the failure, not the empty state, when the read failed and there is no earlier answer', () => {
    expect(screenOf({ mode: 'page', suppressionsFailed: false, failure: 'Could not load the findings.', data: null })).toBe('unavailable');
  });

  it('keeps the explorer on screen over an earlier answer when a later read failed', () => {
    expect(screenOf({ mode: 'page', suppressionsFailed: false, failure: 'Could not load the findings.', data: answered(3) })).toBe('explorer');
  });

  it('is loading until the first answer, with no failure to show', () => {
    expect(screenOf({ mode: 'page', suppressionsFailed: false, failure: null, data: null })).toBe('loading');
  });

  it('is empty only when no rule has a finding, not when the filters match none', () => {
    expect(screenOf({ mode: 'page', suppressionsFailed: false, failure: null, data: answered(0) })).toBe('empty');
    expect(screenOf({ mode: 'page', suppressionsFailed: false, failure: null, data: answered(1) })).toBe('explorer');
  });
});

describe('what stands in for the list', () => {
  const flat = { layout: 'resource' as const, failure: null, ruleRows: 0, grouped: null };

  it('is the failure before it is the empty message, whatever the list held', () => {
    expect(listBodyOf({ ...flat, failure: 'x', items: 0 })).toBe('unavailable');
    expect(listBodyOf({ ...flat, failure: 'x', items: 3 })).toBe('unavailable');
    expect(listBodyOf({ ...flat, layout: 'rule', failure: 'x', items: 0, ruleRows: 0 })).toBe('unavailable');
    expect(listBodyOf({ ...flat, layout: 'rule', failure: 'x', items: 0, ruleRows: 4 })).toBe('unavailable');
    expect(listBodyOf({ ...flat, failure: 'x', items: 0, grouped: { groupTotal: 0 } })).toBe('unavailable');
  });

  it('is empty for a flat list with no findings, and rows for one with some', () => {
    expect(listBodyOf({ ...flat, items: 0 })).toBe('empty');
    expect(listBodyOf({ ...flat, items: 1 })).toBe('rows');
  });

  it('is empty for a grouped list with no groups, and reads groups, not findings, to say so', () => {
    expect(listBodyOf({ ...flat, items: 0, grouped: { groupTotal: 0 } })).toBe('empty');
    expect(listBodyOf({ ...flat, items: 0, grouped: { groupTotal: 2 } })).toBe('rows');
    expect(listBodyOf({ ...flat, items: 5, grouped: { groupTotal: 0 } })).toBe('empty');
  });

  it('is empty for the by-rule list with no rules, and rows for one with some', () => {
    expect(listBodyOf({ ...flat, layout: 'rule', items: 9, ruleRows: 0 })).toBe('empty');
    expect(listBodyOf({ ...flat, layout: 'rule', items: 0, ruleRows: 2 })).toBe('rows');
  });
});

describe('when a group reads', () => {
  it('reads nothing while it is closed', () => {
    expect(openGroupUrl(false, request, ['security'], 1)).toBeNull();
  });

  it('reads its own contents, at its page, once it is open', () => {
    expect(openGroupUrl(true, request, ['security'], 1)).toBe(groupUrl(request, ['security'], 1));
    expect(openGroupUrl(true, request, ['security', null], 3)).toBe(groupUrl(request, ['security', null], 3));
    expect(openGroupUrl(true, request, ['security'], 1)).toContain('/api/findings/group?');
    expect(openGroupUrl(true, request, ['security'], 2)).not.toBe(openGroupUrl(true, request, ['security'], 1));
  });
});

describe('the values a dropdown lists', () => {
  const values = (list: [string, number][], total = list.length): ColumnValuesResponse => ({
    column: 'row.zone', values: list.map(([value, count]) => ({ value, count })), total,
  });

  it('names the empty value No value, and every other by itself, in the order sent', () => {
    expect(valueOptionsOf(values([['b', 5], ['', 2], ['a', 1]]))).toEqual([
      { value: 'b', label: 'b', count: 5 }, { value: '', label: 'No value', count: 2 }, { value: 'a', label: 'a', count: 1 },
    ]);
    expect(valueOptionsOf(null)).toEqual([]);
  });

  const ready = (data: ColumnValuesResponse): Loaded<ColumnValuesResponse> => ({ status: 'ready', data });
  const own = [{ value: 'high', label: 'High' }, { value: 'low', label: 'Low' }];

  it('reads before it has an answer, and says so for a read that is still on its way', () => {
    expect(valuesPanelOf({ remote: true, read: undefined, options: [], search: '' })).toMatchObject({ body: 'loading', failure: null });
    expect(valuesPanelOf({ remote: true, read: { status: 'loading' }, options: [], search: '' })).toMatchObject({ body: 'loading' });
  });

  it('says why a read failed, not that there are no matches', () => {
    const panel = valuesPanelOf({ remote: true, read: { status: 'failed', message: 'Could not load the values. The server answered 500.' }, options: [], search: '' });
    expect(panel).toMatchObject({ body: 'failed', failure: 'Could not load the values. The server answered 500.', options: [] });
  });

  it('lists the values the server sent, and no matches when it sent none', () => {
    expect(valuesPanelOf({ remote: true, read: ready(values([['a', 1]])), options: [], search: '' })).toMatchObject({ body: 'options', options: [{ value: 'a', label: 'a', count: 1 }] });
    expect(valuesPanelOf({ remote: true, read: ready(values([])), options: [], search: 'zzz' })).toMatchObject({ body: 'empty', options: [] });
  });

  it('does not filter the server\'s values by what was typed, since the server did', () => {
    const panel = valuesPanelOf({ remote: true, read: ready(values([['alpha', 1], ['beta', 1]])), options: [], search: 'alp' });
    expect(panel.options.map(o => o.value)).toEqual(['alpha', 'beta']);
  });

  it('filters its own options by what was typed, ignoring case, and never reads', () => {
    expect(valuesPanelOf({ remote: false, read: undefined, options: own, search: '' })).toMatchObject({ body: 'options', options: own });
    expect(valuesPanelOf({ remote: false, read: undefined, options: own, search: 'HIG' })).toMatchObject({ body: 'options', options: [own[0]] });
    expect(valuesPanelOf({ remote: false, read: undefined, options: own, search: 'zzz' })).toMatchObject({ body: 'empty' });
  });

  it('says how many of the values it shows when the server holds more than it sent', () => {
    expect(valuesPanelOf({ remote: true, read: ready(values([['a', 1], ['b', 1]], 340)), options: [], search: '' }).footer)
      .toBe('Showing 2 of 340. Search to narrow the list.');
    expect(valuesPanelOf({ remote: true, read: ready(values([['a', 1], ['b', 1]], 2)), options: [], search: '' }).footer).toBeNull();
    expect(valuesPanelOf({ remote: true, read: { status: 'loading' }, options: [], search: '' }).footer).toBeNull();
    expect(valuesPanelOf({ remote: false, read: undefined, options: own, search: '' }).footer).toBeNull();
  });
});
