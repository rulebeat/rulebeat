/**
 * The dashboard filter bar (ADR 0013): a pick is written to the address with `router.replace` and saves
 * nothing, the bar says what it changed and what the dashboard saved, and it never offers a pick that
 * would widen a dimension. Fixture: the dashboard saves Subscription {A, B}; L holds B only.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardFilterBar, OUTSIDE_ROW, dimensionControl, overrideNote, replaceChanges } from '@/components/dashboard/dashboard-filter-bar';
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

const html = (access: Access, address: string, widgets: { config: Record<string, unknown> }[] = []) => {
  const { state, marks } = barFor(access, address, widgets);
  return renderToStaticMarkup(createElement(DashboardFilterBar, { state, saved: SAVED, marks }));
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
