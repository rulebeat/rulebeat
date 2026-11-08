/**
 * The dashboard filter bar's rules (ADR 0013): what each dimension shows for the saved filters, the
 * changes in the address and the viewer's access, and what a pick writes. The values L cannot see are
 * counted and never named, and a pick never widens a dimension by accident.
 *
 * Fixture: the dashboard saves Subscription {A, B}. L holds B only. M holds A and B.
 */
import { describe, expect, it } from 'vitest';
import {
  ANY_WIDENS_REASON, UNTICK_LAST_REASON, backToSaved, buildBarState, pickAny, toggleValue, type BarLayers,
} from '@/lib/dashboard-bar';
import { dashboardAddress } from '@/lib/finding-view';
import { markOutsideAccess } from '@/lib/outside-access';
import { buildAccess, type Access } from '@/lib/access-model';
import type { DashboardFilters } from '@/lib/finding-view';
import { EVERYTHING_ACCESS } from '../helpers/access';

const SUB_A = '00000000-0000-0000-0000-00000000000a';
const SUB_B = '00000000-0000-0000-0000-00000000000b';
const SUB_C = '00000000-0000-0000-0000-00000000000c';

const holding = (...ids: string[]): Access => buildAccess(
  ids.map(id => ({ tenantId: 't', scope: { kind: 'subscription' as const, path: `/subscriptions/${id}` }, role: 'viewer' as const })),
  'manual',
);
const L = holding(SUB_B);
const M = holding(SUB_A, SUB_B);

const SAVED: DashboardFilters = {
  category: ['security'], subscription: [SUB_A, SUB_B], resourceGroup: [], tags: [], rule: [], severity: [],
  window: { mode: 'relative', days: 30 },
};

function state(access: Access, changes: string, over: Partial<Parameters<typeof buildBarState>[0]> = {}) {
  const address = dashboardAddress(SAVED);
  return buildBarState({
    revision: 4, saved: SAVED, changes: address.read(new URLSearchParams(changes)), access, widgets: [], ...over,
  });
}

describe('what a dimension shows', () => {
  it('counts the saved values L cannot see and names only the one L holds', () => {
    const { state: bar } = state(L, '');
    const subscription = bar.dimensions.subscription;
    expect(subscription.effective).toEqual([SUB_B]);
    expect(subscription.outside).toEqual({ saved: 1, url: 0 });
    expect(JSON.stringify(bar)).not.toContain(SUB_A);
  });

  it('counts a value from M\'s link in the URL layer, and names nothing for L', () => {
    const { state: bar } = state(L, `subscription=${SUB_A}`);
    const subscription = bar.dimensions.subscription;
    expect(subscription.effective).toEqual([]);
    expect(subscription.inUrl).toBe(true);
    expect(subscription.outside).toEqual({ saved: 1, url: 1 });
    expect(JSON.stringify(bar)).not.toContain(SUB_A);
  });

  it('shows M both values and no count', () => {
    const { state: bar } = state(M, '');
    expect(bar.dimensions.subscription.effective.sort()).toEqual([SUB_A, SUB_B]);
    expect(bar.dimensions.subscription.outside).toEqual({ saved: 0, url: 0 });
  });

  it('marks a dimension Changed only when the address differs from what is saved', () => {
    expect(state(M, 'severity=high').state.dimensions.severity.changed).toBe(true);
    expect(state(M, 'severity=high').state.dimensions.category.changed).toBe(false);
    expect(state(M, 'category=security').state.dimensions.category.changed).toBe(false);
    expect(state(M, 'category=').state.dimensions.category).toMatchObject({ changed: true, effective: [], saved: ['security'] });
  });

  it('marks the window as changed, and keeps the saved one for the Saved line', () => {
    const { window } = state(M, 'window=7').state;
    expect(window).toEqual({ changed: true, saved: { mode: 'relative', days: 30 }, effective: { mode: 'relative', days: 7 } });
    expect(state(M, 'window=30').state.window.changed).toBe(false);
  });

  it('carries the revision it was computed from', () => {
    expect(state(M, '').state.revision).toBe(4);
  });
});

describe('a value that no longer exists', () => {
  const known = { category: new Set(['cost']), rule: new Set(['rule-1']), tags: new Set<string>() };

  it('stays in the dimension, named, with the reason it counts nothing', () => {
    const { state: bar } = state(M, '', { known });
    expect(bar.dimensions.category.effective).toEqual(['security']);
    expect(bar.dimensions.category.vanished).toEqual([{ value: 'security', label: 'security', note: 'No longer exists' }]);
  });

  it('says a rule that is gone is a rule that no longer exists, without an id', () => {
    const { state: bar } = state(M, 'ruleId=rule-9', { known });
    expect(bar.dimensions.rule.vanished).toEqual([{ value: 'rule-9', label: 'A rule that no longer exists', note: 'A rule that no longer exists' }]);
  });

  it('marks nothing when the server has no list to check against', () => {
    expect(state(M, 'ruleId=rule-9').state.dimensions.rule.vanished).toEqual([]);
  });

  it('names a Scope value that is gone only for Everything', () => {
    const known = { subscription: new Set([SUB_A]) };
    expect(state(EVERYTHING_ACCESS, '', { known }).state.dimensions.subscription.vanished).toEqual([{ value: SUB_B, label: SUB_B, note: 'No longer exists' }]);

    const scoped = state(M, '', { known });
    expect(scoped.state.dimensions.subscription.vanished).toEqual([]);
    expect(scoped.state.dimensions.subscription.outside.saved).toBe(1);
    expect(JSON.stringify(scoped.state)).not.toContain(SUB_B);
  });
});

describe('widgets that set their own value', () => {
  it('counts them per dimension', () => {
    const widgets = [
      { config: { severities: ['low'] } }, { config: { severities: ['high'], category: 'cost' } }, { config: { category: 'all', severities: [] } },
      { config: { windowDays: 7 } },
    ];
    const { overriddenBy } = state(M, '', { widgets }).state;
    expect(overriddenBy).toEqual({ category: 1, subscription: 0, resourceGroup: 0, tags: 0, rule: 0, severity: 2, window: 1 });
  });
});

describe('the held-back marks the bar writes by', () => {
  it('cover the saved layer, the address and the widgets, and the marks of L name what L cannot see', () => {
    const { marks } = state(L, `subscription=${SUB_C}`, { widgets: [{ config: { subscriptions: [SUB_A] } }] });
    expect(marks.subscriptions.sort()).toEqual([SUB_A, SUB_C].sort());
  });
});

describe('a pick', () => {
  const layers = (access: Access, changes: string): BarLayers => ({
    saved: SAVED,
    changes: dashboardAddress(SAVED).read(new URLSearchParams(changes)),
    marks: markOutsideAccess(access, { subscriptions: [SUB_A, SUB_B, SUB_C] }),
  });
  const written = (picked: ReturnType<typeof toggleValue>, saved = SAVED) => {
    if ('refused' in picked) throw new Error(picked.refused);
    return dashboardAddress(saved).write(picked.changes).toString();
  };

  it('is refused when it would leave L only values L cannot see, and writes nothing', () => {
    expect(toggleValue(layers(L, ''), 'subscription', SUB_B)).toEqual({ refused: UNTICK_LAST_REASON });
  });

  it('is allowed when the address already carries the held value', () => {
    const result = toggleValue(layers(L, `subscription=${SUB_A}%2C${SUB_B}`), 'subscription', SUB_B);
    expect(written(result)).toBe(`subscription=${SUB_A}`);
  });

  it('is refused when the address holds only a value L may see over held saved values', () => {
    expect(toggleValue(layers(L, `subscription=${SUB_B}`), 'subscription', SUB_B)).toEqual({ refused: UNTICK_LAST_REASON });
  });

  it('carries only the person\'s own choice when it replaces a dimension that saved held-back values', () => {
    expect(written(toggleValue(layers(holding(SUB_B, SUB_C), ''), 'subscription', SUB_C))).toBe(`subscription=${SUB_B}%2C${SUB_C}`);
  });

  it('never writes an empty subscription for L, whatever L unticks', () => {
    const picks = [toggleValue(layers(L, ''), 'subscription', SUB_B), toggleValue(layers(L, `subscription=${SUB_B}`), 'subscription', SUB_B)];
    for (const pick of picks) expect('changes' in pick).toBe(false);
  });

  it('lets M untick down to any, as an explicit empty value', () => {
    const result = toggleValue(layers(M, `subscription=${SUB_B}`), 'subscription', SUB_B);
    expect(written(result)).toBe('subscription=');
  });

  it('writes no subscription param when L changes Severity', () => {
    expect(written(toggleValue(layers(L, ''), 'severity', 'high'))).toBe('severity=high');
  });

  it('keeps a held value from a link as written when L edits another dimension', () => {
    expect(written(toggleValue(layers(L, `subscription=${SUB_A}`), 'severity', 'high'))).toBe(`subscription=${SUB_A}&severity=high`);
  });

  it('drops a dimension from the address when it is set back to what is saved', () => {
    const result = toggleValue(layers(M, 'category='), 'category', 'security');
    expect(written(result)).toBe('');
  });

  it('picks Any as an explicit empty value, and explains that it widens the link on a held dimension', () => {
    expect(written(pickAny(layers(M, ''), 'severity'), { ...SAVED, severity: ['high'] })).toBe('severity=');
    expect(ANY_WIDENS_REASON).toMatch(/widens/);
  });

  it('goes back to saved for one dimension and leaves the others', () => {
    const next = backToSaved(layers(M, 'severity=high&window=7').changes, 'severity');
    expect(dashboardAddress(SAVED).write(next).toString()).toBe('window=7');
    expect(dashboardAddress(SAVED).write(backToSaved(next, 'window')).toString()).toBe('');
  });
});
