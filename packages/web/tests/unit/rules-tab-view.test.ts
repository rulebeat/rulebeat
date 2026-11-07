/**
 * What the Rules tab shows (#402): the server's list, with free-text search the only filter left in the
 * browser, and a bulk selection that never holds a rule the list does not show.
 */
import { describe, expect, it } from 'vitest';
import { pruneSelection } from '@/lib/rule-bulk-selection';
import { shownRules } from '@/lib/rules-tab-view';
import type { RulesTabEntry } from '@/lib/rules-tab-list';
import type { Rule } from '@/lib/types';

const rule = (id: string, over: Partial<Rule> = {}): Rule => ({
  id, name: `Rule ${id}`, description: '', category: 'security', severity: 'high', enabled: true, type: 'custom',
  scope: { level: 'subscription' }, resourceTypes: [], conditions: [], ...over,
} as Rule);
const entry = (id: string, over: Partial<RulesTabEntry> = {}): RulesTabEntry => ({ id, outcome: 'passing', findingCount: 0, ...over });

const POLICIES = [rule('a'), rule('b'), rule('c', { name: 'Storage encryption' })];

describe('shownRules', () => {
  it('shows the rules the server listed, in its order, with their entries', () => {
    const shown = shownRules([entry('c', { findingCount: 2 }), entry('a')], POLICIES, '', () => undefined);
    expect(shown.map(s => s.policy.id)).toEqual(['c', 'a']);
    expect(shown[0]!.entry.findingCount).toBe(2);
  });

  it('shows no rule the server did not list, whatever the policies hold', () => {
    expect(shownRules([entry('a')], POLICIES, '', () => undefined).map(s => s.policy.id)).toEqual(['a']);
    expect(shownRules([], POLICIES, '', () => undefined)).toEqual([]);
  });

  it('leaves out a listed rule the browser does not hold', () => {
    expect(shownRules([entry('gone'), entry('a')], POLICIES, '', () => undefined).map(s => s.policy.id)).toEqual(['a']);
  });

  it('narrows the listed rules by free-text search, which stays in the browser', () => {
    const listed = [entry('a'), entry('b'), entry('c')];
    expect(shownRules(listed, POLICIES, 'storage', () => undefined).map(s => s.policy.id)).toEqual(['c']);
    expect(shownRules(listed, POLICIES, 'nothing like it', () => undefined)).toEqual([]);
  });

  it('searches the category label the page shows', () => {
    const labels = (id: string) => (id === 'security' ? 'Security and compliance' : undefined);
    expect(shownRules([entry('a')], POLICIES, 'compliance', labels).map(s => s.policy.id)).toEqual(['a']);
  });

  it('shows the rule as the browser holds it, so a toggle shows before the list is read again', () => {
    const toggled = POLICIES.map(p => (p.id === 'a' ? { ...p, enabled: false } : p));
    expect(shownRules([entry('a')], toggled, '', () => undefined)[0]!.policy.enabled).toBe(false);
  });
});

describe('the bulk selection against the server list', () => {
  it('drops the rules a URL filter hides, and keeps the ones it still lists', () => {
    const selection = new Set(['a', 'b', 'c']);
    const afterFilter = shownRules([entry('b')], POLICIES, '', () => undefined).map(s => s.policy);
    expect([...pruneSelection(selection, afterFilter)]).toEqual(['b']);
  });

  it('does not bring a dropped rule back when the filter is widened again', () => {
    const selection = new Set(['a', 'b']);
    const narrowed = pruneSelection(selection, shownRules([entry('b')], POLICIES, '', () => undefined).map(s => s.policy));
    const widened = pruneSelection(narrowed, shownRules([entry('a'), entry('b')], POLICIES, '', () => undefined).map(s => s.policy));
    expect([...widened]).toEqual(['b']);
  });

  it('empties the selection when the list is empty', () => {
    expect(pruneSelection(new Set(['a']), shownRules([], POLICIES, '', () => undefined).map(s => s.policy)).size).toBe(0);
  });
});
