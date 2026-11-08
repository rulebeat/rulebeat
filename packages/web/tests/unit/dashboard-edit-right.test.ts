/**
 * A person without the edit right is not offered Edit, so the client never sends the edit-mode preview
 * the server refuses (it answers 403 without dashboards:write). The control is shown off with its reason.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DashboardGridClient } from '@/app/(app)/dashboards/[id]/dashboard-grid-client';
import { SCOPED_DASHBOARD_REASON } from '@/lib/write-controls';
import { buildBarState } from '@/lib/dashboard-bar';
import { savedFiltersOf } from '@/lib/dashboard-filters';
import type { Dashboard } from '@/lib/types';
import { EVERYTHING_ACCESS } from '../helpers/access';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => '/dashboards/d1',
  useSearchParams: () => new URLSearchParams(),
}));

const DASHBOARD = {
  id: 'd1', name: 'Overview', isDefault: true, createdAt: '2026-01-01T00:00:00Z', revision: 1,
  config: { widgets: [], filters: {} },
} as unknown as Dashboard;

const BAR = buildBarState({ revision: 1, saved: savedFiltersOf(DASHBOARD.config), changes: {}, access: EVERYTHING_ACCESS, widgets: [] });

const render = (edit: { allowed: boolean; reason?: string }) => renderToStaticMarkup(createElement(DashboardGridClient, {
  dashboard: DASHBOARD, outsideAccess: BAR.marks, bar: BAR.state, edit,
}));

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
