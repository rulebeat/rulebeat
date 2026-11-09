/**
 * The dashboard filter bar (ADR 0013): a pick is written to the address with `router.replace` and saves
 * nothing, the bar says what it changed and what the dashboard saved, and it never offers a pick that
 * would widen a dimension. Fixture: the dashboard saves Subscription {A, B}; L holds B only.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardFilterBar, OUTSIDE_ROW, SaveRegion, afterSave, dimensionControl, overrideNote, replaceChanges } from '@/components/dashboard/dashboard-filter-bar';
import { ChecklistPanel } from '@/components/ui/checklist-dropdown';
import { buildBarState, UNTICK_LAST_REASON } from '@/lib/dashboard-bar';
import { dashboardAddress } from '@/lib/finding-view';
import { buildAccess, type Access } from '@/lib/access-model';
import type { DashboardFilters } from '@/lib/finding-view';
import { EVERYTHING_ACCESS } from '../helpers/access';

let query = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => '/dashboards/d1',
  useSearchParams: () => new URLSearchParams(query),
}));
beforeEach(() => { query = ''; });

const SUB_A = '00000000-0000-0000-0000-00000000000a';
const SUB_B = '00000000-0000-0000-0000-00000000000b';
const holding = (...ids: string[]): Access => buildAccess(
  ids.map(id => ({ tenantId: 't', scope: { kind: 'subscription' as const, path: `/subscriptions/${id}` }, role: 'viewer' as const })),
  'manual',
);
const L = holding(SUB_B);

const SAVED: DashboardFilters = {
  category: [], subscription: [SUB_A, SUB_B], resourceGroup: [], tags: [], rule: [], severity: ['critical'],
  window: { mode: 'relative', days: 30 },
};

function barFor(access: Access, address: string, widgets: { config: Record<string, unknown> }[] = []) {
  query = address;
  const changes = dashboardAddress(SAVED).read(new URLSearchParams(address));
  const built = buildBarState({ revision: 1, saved: SAVED, changes, access, widgets });
  return { ...built, changes };
}

const SAVE_ALLOWED = { allowed: true, run: vi.fn(), duplicate: vi.fn() };

const html = (access: Access, address: string, widgets: { config: Record<string, unknown> }[] = []) => {
  const { state, marks } = barFor(access, address, widgets);
  return renderToStaticMarkup(createElement(DashboardFilterBar, { state, saved: SAVED, marks, save: SAVE_ALLOWED }));
};

describe('the Subscription checklist for L', () => {
  const control = (address: string, replace = vi.fn()) => {
    const { state, marks, changes } = barFor(L, address);
    const options = [{ value: SUB_A, label: 'A' }, { value: SUB_B, label: 'B' }].filter(o => o.value === SUB_B);
    return { replace, ...dimensionControl({ dimension: 'subscription', state, layers: { saved: SAVED, changes, marks }, options, replace }) };
  };

  it('shows B ticked but off with its reason, and one untickable row for what L cannot see', () => {
    const c = control('');
    const panel = renderToStaticMarkup(createElement(ChecklistPanel, {
      label: 'Subscription', options: c.options, selected: c.selected, onToggle: c.onToggle, onClear: c.onClear, clearHint: c.clearHint,
    }));
    expect(panel).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""[^>]*disabled=""|<input[^>]*type="checkbox"[^>]*disabled=""[^>]*checked=""/);
    expect(panel).toContain(UNTICK_LAST_REASON);
    expect(panel).toContain('1 outside your access');
    expect(panel).not.toContain(SUB_A);
    expect(c.count).toBe(2);
  });

  it('writes nothing when L unticks B, and never an empty subscription', () => {
    const c = control('');
    c.onToggle(SUB_B);
    c.onToggle(OUTSIDE_ROW);
    expect(c.replace).not.toHaveBeenCalled();
  });

  it('allows the untick when the address already carries the held value', () => {
    const c = control(`subscription=${SUB_A}%2C${SUB_B}`);
    c.onToggle(SUB_B);
    expect(c.replace).toHaveBeenCalledWith({ subscription: [SUB_A] });
  });

  it('offers Any with the reason it widens the link, once something is held back', () => {
    expect(control('').clearHint).toMatch(/widens/);
  });
});

describe('L editing another dimension', () => {
  const edit = (address: string): string => {
    const { state, marks, changes } = barFor(L, address);
    const router = { replace: vi.fn() };
    const control = dimensionControl({
      dimension: 'severity', state, layers: { saved: SAVED, changes, marks }, options: [{ value: 'high', label: 'High' }],
      replace: next => replaceChanges(router, '/dashboards/d1', new URLSearchParams(address), SAVED, next),
    });
    control.onToggle('high');
    return router.replace.mock.calls[0]![0] as string;
  };

  it('writes an address with no subscription param', () => {
    expect(edit('')).toBe('/dashboards/d1?severity=critical%2Chigh');
  });

  it('keeps a value from a link as written', () => {
    expect(edit(`subscription=${SUB_A}`)).toBe(`/dashboards/d1?subscription=${SUB_A}&severity=critical%2Chigh`);
  });
});

describe('writing to the address', () => {
  const router = () => ({ replace: vi.fn(), push: vi.fn() });

  it('replaces the history entry with only the changes, and keeps params the page owns', () => {
    const r = router();
    replaceChanges(r, '/dashboards/d1', new URLSearchParams('tab=x&severity=high'), SAVED, { severity: ['low'] });
    expect(r.replace).toHaveBeenCalledWith('/dashboards/d1?tab=x&severity=low', { scroll: false });
    expect(r.push).not.toHaveBeenCalled();
  });

  it('goes to the bare path when nothing differs from saved', () => {
    const r = router();
    replaceChanges(r, '/dashboards/d1', new URLSearchParams('severity=high'), SAVED, { severity: ['critical'] });
    expect(r.replace).toHaveBeenCalledWith('/dashboards/d1', { scroll: false });
  });
});

describe('the bar as drawn', () => {
  it('has nothing marked while the address holds no changes', () => {
    const bar = html(EVERYTHING_ACCESS, '');
    expect(bar).not.toContain('Changed');
    expect(bar).not.toContain('Back to saved');
    expect(bar).not.toContain('Reset to saved filters');
  });

  it('marks a changed dimension with what the dashboard saved and a way back, and offers the reset', () => {
    const bar = html(EVERYTHING_ACCESS, 'severity=high');
    expect(bar).toContain('Changed');
    expect(bar).toContain('Saved: Critical');
    expect(bar).toContain('Back to saved');
    expect(bar).toContain('Reset to saved filters');
  });

  it('marks a changed window the same way', () => {
    const bar = html(EVERYTHING_ACCESS, 'window=7');
    expect(bar).toContain('Saved: 30d');
    expect(bar).toContain('Back to saved');
  });

  it('has no bar-level Clear', () => {
    expect(html(EVERYTHING_ACCESS, 'severity=high')).not.toMatch(/>\s*(<[^>]*>)*\s*Clear\s*</);
  });

  it('says the link carries only the changes', () => {
    const bar = html(EVERYTHING_ACCESS, '');
    expect(bar).toContain('Copy link');
    expect(bar).toContain('The link carries only the changes. Each person sees what their own Access allows.');
  });

  it('says how many widgets use their own value', () => {
    expect(html(EVERYTHING_ACCESS, '', [{ config: { severities: ['low'] } }, { config: { severities: ['high'] } }])).toContain('2 widgets use their own severity');
    expect(overrideNote('severity', 1)).toBe('1 widget uses its own severity');
    expect(overrideNote('category', 0)).toBeNull();
  });

  it('counts what L cannot see in the Saved line and names none of it', () => {
    const bar = html(L, 'subscription=');
    expect(bar).toMatch(/Saved: [^<]*1 outside your access/);
    expect(bar).not.toContain(SUB_A);
  });
});

describe('the Saved line for a rule that was deleted', () => {
  it('says a rule that no longer exists, never its id', () => {
    const saved: DashboardFilters = { ...SAVED, rule: ['rule-9'] };
    query = 'ruleId=rule-1';
    const changes = dashboardAddress(saved).read(new URLSearchParams(query));
    const { state, marks } = buildBarState({
      revision: 1, saved, changes, access: EVERYTHING_ACCESS, widgets: [],
      known: { rule: new Set(['rule-1']) },
    });
    const bar = renderToStaticMarkup(createElement(DashboardFilterBar, { state, saved, marks, save: SAVE_ALLOWED }));
    expect(bar).toContain('Saved: A rule that no longer exists');
    expect(bar).not.toContain('rule-9');
  });
});

describe('an effective value the option list does not offer', () => {
  it('stays shown, ticked and untickable, named from the rule list', () => {
    const saved: DashboardFilters = { ...SAVED, rule: ['rule-1'] };
    const changes = dashboardAddress(saved).read(new URLSearchParams(''));
    const { state, marks } = buildBarState({ revision: 1, saved, changes, access: EVERYTHING_ACCESS, widgets: [], known: { rule: new Set(['rule-1', 'rule-2']) } });
    const replace = vi.fn();
    const control = dimensionControl({
      dimension: 'rule', state, layers: { saved, changes, marks }, options: [{ value: 'rule-2', label: 'Rule two' }], replace,
      nameOf: id => ({ 'rule-1': 'Rule one' })[id] ?? id,
    });
    expect(control.options.map(o => [o.value, o.label])).toEqual([['rule-2', 'Rule two'], ['rule-1', 'Rule one']]);
    expect([...control.selected]).toEqual(['rule-1']);
    expect(control.count).toBe(1);
    control.onToggle('rule-1');
    expect(replace).toHaveBeenCalledWith({ rule: [] });
  });
});

const SAVE = "Save as this dashboard's filters";

describe('Save as this dashboard\'s filters in the bar', () => {
  const buttonWith = (markup: string, label: string): string =>
    markup.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}(?:(?!</button>).)*</button>`, 's'))?.[0] ?? '';
  const isDisabled = (button: string): boolean => /\sdisabled(=|\s|>)/.test(button);
  const render = (address: string, save: { allowed: boolean; reason?: string }) => {
    const { state, marks } = barFor(EVERYTHING_ACCESS, address);
    return renderToStaticMarkup(createElement(DashboardFilterBar, { state, saved: SAVED, marks, save: { ...SAVE_ALLOWED, ...save } }));
  };

  it('is not shown while the address holds no changes', () => {
    expect(render('', { allowed: true })).not.toContain(SAVE);
  });

  it('is shown and on while changes exist and the person may edit', () => {
    const button = buttonWith(render('severity=high', { allowed: true }), SAVE.replace("'", '&#x27;'));
    expect(button).not.toBe('');
    expect(isDisabled(button)).toBe(false);
  });

  it('is off with the reason in view, and Duplicate offered, for someone who may not edit', () => {
    const markup = render('severity=high', { allowed: false, reason: 'Changing a dashboard needs the Editor Role.' });
    expect(isDisabled(buttonWith(markup, SAVE.replace("'", '&#x27;')))).toBe(true);
    expect(markup).toContain('Changing a dashboard needs the Editor Role.');
    expect(buttonWith(markup, 'Duplicate')).not.toBe('');
  });

  it('does not offer Duplicate beside a save that is on', () => {
    expect(buttonWith(render('severity=high', { allowed: true }), 'Duplicate')).toBe('');
  });
});

describe('the answer to a save', () => {
  it('clears the changes from the address when it was saved', () => {
    const replace = vi.fn();
    expect(afterSave({ kind: 'saved', revision: 5, bar: {} as never, dashboard: {} as never }, replace)).toBeNull();
    expect(replace).toHaveBeenCalledWith({});
  });

  it('keeps the address and shows a refusal with how many values to remove', () => {
    const replace = vi.fn();
    expect(afterSave({ kind: 'refused', message: 'Remove them.', outside: 1 }, replace)).toEqual({ message: 'Remove them.', outside: 1 });
    expect(replace).not.toHaveBeenCalled();
  });

  it('keeps the address and shows why a save failed', () => {
    const replace = vi.fn();
    expect(afterSave({ kind: 'failed', message: 'Nope.' }, replace)).toEqual({ message: 'Nope.' });
    expect(replace).not.toHaveBeenCalled();
  });

  it('leaves a conflict to the page, which reloads the bar and says who changed it', () => {
    const replace = vi.fn();
    expect(afterSave({ kind: 'conflict', revision: 9, message: 'Changed.' }, replace)).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('a refused save for L, whose address names A', () => {
  const region = (outside: number | undefined) => renderToStaticMarkup(createElement(SaveRegion, {
    changed: true, allowed: true, saving: false, refusal: { message: 'Your changes include values outside your access.', outside },
    onSave: () => undefined, onRemoveOutside: () => undefined, onDuplicate: () => undefined,
  }));

  it('offers to remove the values outside L\'s access, counted and never named', () => {
    const markup = region(1);
    expect(markup).toContain('Remove 1 value outside your access');
    expect(markup).toContain('Your changes include values outside your access.');
    expect(markup).not.toContain(SUB_A);
  });

  it('counts more than one', () => {
    expect(region(2)).toContain('Remove 2 values outside your access');
  });

  it('offers nothing to remove when the refusal is not about access', () => {
    expect(region(undefined)).not.toContain('Remove');
  });
});
