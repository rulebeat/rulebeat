/**
 * A person without the edit right is not offered Edit, so the client never sends the edit-mode preview
 * the server refuses (it answers 403 without dashboards:write). The control is shown off with its reason.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardGridClient } from '@/app/(app)/dashboards/[id]/dashboard-grid-client';
import { SCOPED_DASHBOARD_REASON } from '@/lib/write-controls';
import { buildBarState } from '@/lib/dashboard-bar';
import { savedFiltersOf } from '@/lib/dashboard-filters';
import { dashboardAddress } from '@/lib/finding-view';
import type { Dashboard } from '@/lib/types';
import { EVERYTHING_ACCESS } from '../helpers/access';

let query = '';
beforeEach(() => { query = ''; });
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => '/dashboards/d1',
  useSearchParams: () => new URLSearchParams(query),
}));

const DASHBOARD = {
  id: 'd1', name: 'Overview', isDefault: true, createdAt: '2026-01-01T00:00:00Z', revision: 1,
  config: { widgets: [], filters: {} },
} as unknown as Dashboard;

const SAVED = savedFiltersOf(DASHBOARD.config);
const barFor = (address: string) => buildBarState({
  revision: 1, saved: SAVED, changes: dashboardAddress(SAVED).read(new URLSearchParams(address)), access: EVERYTHING_ACCESS, widgets: [],
});

const render = (edit: { allowed: boolean; reason?: string }, address = '') => (query = address, renderToStaticMarkup(createElement(DashboardGridClient, {
  dashboard: DASHBOARD, outsideAccess: barFor(address).marks, bar: barFor(address).state, edit,
})));

/** The `disabled` attribute, not the `disabled:` utility classes every button carries. */
const isDisabled = (button: string): boolean => /\sdisabled(=|\s|>)/.test(button);

const buttonWith = (html: string, label: string): string =>
  html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}(?:(?!</button>).)*</button>`, 's'))?.[0] ?? '';

describe('the Edit control', () => {
  it('is on for someone who may edit', () => {
    const edit = buttonWith(render({ allowed: true }), 'Edit');
    expect(edit).not.toBe('');
    expect(isDisabled(edit)).toBe(false);
  });

  it('is off with its reason for someone who may not', () => {
    const edit = buttonWith(render({ allowed: false, reason: SCOPED_DASHBOARD_REASON }), 'Edit');
    expect(isDisabled(edit)).toBe(true);
    expect(edit).toContain(SCOPED_DASHBOARD_REASON.replace(/'/g, '&#x27;'));
  });

  it('turns the empty dashboard\'s Add your first widget off too', () => {
    const add = buttonWith(render({ allowed: false, reason: SCOPED_DASHBOARD_REASON }), 'Add your first widget');
    expect(isDisabled(add)).toBe(true);
  });
});

describe('Save as this dashboard\'s filters', () => {
  const SAVE = 'Save as this dashboard&#x27;s filters';

  it('is on for someone who may edit, once the address holds a change', () => {
    const save = buttonWith(render({ allowed: true }, 'severity=high'), SAVE);
    expect(save).not.toBe('');
    expect(isDisabled(save)).toBe(false);
  });

  it('is off with the server\'s reason for someone who may not, and Duplicate is offered beside it', () => {
    const markup = render({ allowed: false, reason: SCOPED_DASHBOARD_REASON }, 'severity=high');
    expect(isDisabled(buttonWith(markup, SAVE))).toBe(true);
    expect(markup).toContain(SCOPED_DASHBOARD_REASON.replace(/'/g, '&#x27;'));
    expect(buttonWith(markup, 'Duplicate')).not.toBe('');
  });

  it('is not shown while the address holds no change', () => {
    expect(render({ allowed: true })).not.toContain(SAVE);
  });
});
