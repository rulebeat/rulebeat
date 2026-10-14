/**
 * #275: what a person with less than Everything is shown on the screens that carry a rule's scope and the
 * library and schedule write controls. Rendered on the server, in the style of explorer-no-access.test.ts:
 * a hidden scope entry reads "Outside your access" once per entry, and a control that is off carries the
 * reason instead of being missing or failing with a 403 on click.
 */
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ScopeTreePicker } from '@/components/rules/scope-tree-picker';
import { RuleForm } from '@/components/rules/rule-form';
import { SchedulesTab } from '@/components/modules/schedules-tab';
import { ScansClient } from '@/components/modules/scans-client';
import { LibraryClient } from '@/app/(app)/library/library-client';
import { RuleDetailClient } from '@/app/(app)/rules/[id]/rule-detail-client';
import { OUTSIDE_ACCESS_LABEL } from '@/lib/outside-access';
import { ThemeProvider } from '@/components/theme/theme-provider';
import { SettingsClient } from '@/app/(app)/settings/settings-client';
import { SCOPED_CATEGORY_REASON, SCOPED_WRITE_REASON, type WriteControls } from '@/lib/write-controls';
import { emptyView } from '@/lib/finding-view';
import type { Rule } from '@/lib/types';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => '/scans',
  useSearchParams: () => new URLSearchParams(),
}));

const SUB = '00000000-0000-0000-0000-00000000000a';
const count = (html: string, text: string): number => html.split(text).length - 1;
/** The text of a title attribute, as React writes it (an apostrophe is escaped). */
const titled = (html: string, reason: string): number => count(html, `title="${reason.replace(/'/g, '&#x27;')}"`);

const RULE = {
  id: 'rule-1', name: 'A scoped rule', description: 'Checks things', category: 'security', severity: 'medium', enabled: true,
  type: 'custom', kind: 'state', queryBackend: 'resource-graph', scope: { level: 'subscription', subscriptions: [SUB], outsideAccess: 2 },
  resourceTypes: [], conditions: [], rawKql: 'resources | project id', tags: [],
} as unknown as Rule;

const SCOPED_EDITOR: WriteControls = { rulesWrite: false, rulesDelete: false, schedulesWrite: false, suppress: true, reason: SCOPED_WRITE_REASON };
const VIEWER: WriteControls = { rulesWrite: false, rulesDelete: false, schedulesWrite: false, suppress: false };
const EDITOR_ON_EVERYTHING: WriteControls = { rulesWrite: true, rulesDelete: true, schedulesWrite: true, suppress: true };

describe('a hidden scope entry', () => {
  const picker = (props: { subscriptions?: string[]; outsideAccess?: number }) => renderToStaticMarkup(createElement(ScopeTreePicker, {
    subscriptions: props.subscriptions ?? [], managementGroups: [], onChange: () => undefined, outsideAccess: props.outsideAccess,
  }));

  it('shows as "Outside your access" once per entry in the scope picker', () => {
    expect(count(picker({ subscriptions: [SUB], outsideAccess: 2 }), OUTSIDE_ACCESS_LABEL)).toBe(2);
    expect(count(picker({ outsideAccess: 3 }), OUTSIDE_ACCESS_LABEL)).toBe(3);
    expect(count(picker({ subscriptions: [SUB] }), OUTSIDE_ACCESS_LABEL)).toBe(0);
  });

  it('never reads as the whole tenant when entries are hidden', () => {
    expect(picker({})).toContain('All subscriptions (entire tenant)');
    expect(picker({ outsideAccess: 1 })).not.toContain('All subscriptions (entire tenant)');
  });

  it('shows in the rule form\'s scope once per entry', () => {
    const html = renderToStaticMarkup(createElement(RuleForm, { initial: RULE, readOnly: true, canAuthor: false }));
    expect(count(html, OUTSIDE_ACCESS_LABEL)).toBe(2);
  });
});

describe('the library and schedule controls of a scoped Editor', () => {
  const library = (controls: WriteControls) => renderToStaticMarkup(createElement(LibraryClient, {
    initialRules: [RULE], newerVersions: {}, packManifest: {}, categories: [], initialSidebarPinned: true,
    canAuthor: controls.rulesWrite, canDelete: controls.rulesDelete, writeReason: controls.reason,
  }));

  it('shows New rule, duplicate and delete in the library disabled, with the reason', () => {
    const html = library(SCOPED_EDITOR);
    expect(html).toContain('New rule');
    expect(titled(html, SCOPED_WRITE_REASON)).toBe(3);
    expect(html).not.toContain('title="Duplicate as Custom"');
  });

  it('shows a Viewer what a Viewer is shown today: no write control and no reason', () => {
    const html = library(VIEWER);
    expect(html).not.toContain('New rule');
    expect(html).not.toContain(SCOPED_WRITE_REASON);
    expect(html).not.toContain('Duplicate as Custom');
  });

  it('shows an Editor on Everything the working controls', () => {
    const html = library(EDITOR_ON_EVERYTHING);
    expect(html).toContain('New rule');
    expect(html).toContain('title="Duplicate as Custom"');
    expect(html).not.toContain(SCOPED_WRITE_REASON);
  });

  it('shows the rule page\'s Edit and Duplicate disabled, with the reason', () => {
    const html = renderToStaticMarkup(createElement(RuleDetailClient, { rule: RULE, canAuthor: false, canVersion: false, writeReason: SCOPED_WRITE_REASON }));
    expect(titled(html, SCOPED_WRITE_REASON)).toBeGreaterThanOrEqual(3);
    expect(html).toContain('disabled=""');
  });

  const scans = (controls: WriteControls) => renderToStaticMarkup(createElement(ScansClient, {
    policies: [RULE], categories: [], role: 'editor', activeTab: 'rules', controls, ruleFindingCounts: { 'rule-1': 2 },
    initialView: emptyView(),
  }));

  it('shows the Rules tab\'s bulk, toggle and clear controls disabled, with the reason', () => {
    const html = scans(SCOPED_EDITOR);
    expect(html).toContain('Enable');
    expect(html).toContain('Clear findings');
    expect(titled(html, SCOPED_WRITE_REASON)).toBeGreaterThanOrEqual(5);
    expect(html).not.toContain('Read-only access');
  });

  it('shows a Viewer the Rules tab as before: read-only, no reason', () => {
    const html = scans(VIEWER);
    expect(html).toContain('Read-only access');
    expect(html).not.toContain(SCOPED_WRITE_REASON);
    expect(html).not.toContain('Clear findings');
  });

  it('shows an Editor on Everything the Rules tab\'s controls working', () => {
    const html = scans(EDITOR_ON_EVERYTHING);
    expect(html).toContain('Clear findings');
    expect(html).not.toContain(SCOPED_WRITE_REASON);
  });

  const schedules = (canEdit: boolean, disabledReason?: string) => renderToStaticMarkup(createElement(SchedulesTab, {
    initialSchedules: [{
      id: 's1', name: 'Nightly', targetType: 'all', targetValues: [], recurrenceType: 'daily', interval: 1, daysOfWeek: null, dayOfMonth: null,
      startAt: '2026-06-01T00:00:00.000Z', endType: 'never', endDate: null, enabled: true, nextRunAt: '2026-06-02T00:00:00.000Z',
      lastRunAt: null, createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z', lastRun: null, notificationLinks: [],
    }],
    categories: [], rules: [RULE], channels: [], canEdit, disabledReason,
  }));

  it('shows every schedule control disabled, with the reason', () => {
    const html = schedules(false, SCOPED_WRITE_REASON);
    expect(html).toContain('New schedule');
    // New schedule, the switch, Run now, Edit and Delete.
    expect(titled(html, SCOPED_WRITE_REASON)).toBe(5);
  });

  it('shows a Viewer no schedule control and no reason', () => {
    const html = schedules(false);
    expect(html).not.toContain('New schedule');
    expect(html).not.toContain(SCOPED_WRITE_REASON);
  });

  it('shows an Editor on Everything the working schedule controls', () => {
    const html = schedules(true);
    expect(html).toContain('New schedule');
    expect(html).toContain('title="Delete schedule"');
  });
});

describe('the category controls on the Settings page', () => {
  const settings = (props: { canEditCategories: boolean; categoriesOffReason?: string; role?: 'viewer' | 'editor' | 'admin' }) =>
    renderToStaticMarkup(createElement(ThemeProvider, { initialPreference: 'light' } as ComponentProps<typeof ThemeProvider>, createElement(SettingsClient, {
      initialCategories: [{ id: 'security', label: 'Security', isBuiltin: false, sortOrder: 0 }] as never,
      role: props.role ?? 'editor', canEditCategories: props.canEditCategories, categoriesOffReason: props.categoriesOffReason,
      initialAzureStatus: null, initialSignInStatus: null, initialChannels: null,
    })));

  it('shows New category, Edit and Delete disabled with the reason, and no read-only banner, for a scoped Editor', () => {
    const html = settings({ canEditCategories: false, categoriesOffReason: SCOPED_CATEGORY_REASON });
    expect(html).toContain('New category');
    // New category, Edit and Delete each carry it as a title; the panel text states it once more.
    expect(titled(html, SCOPED_CATEGORY_REASON)).toBe(3);
    expect(html).not.toContain('You can see everything here, but not change it');
  });

  it('shows a Viewer what a Viewer is shown today: the read-only banner, no category control, no reason', () => {
    const html = settings({ canEditCategories: false, role: 'viewer' });
    expect(html).toContain('You can see everything here, but not change it');
    expect(html).not.toContain('New category');
    expect(html).not.toContain(SCOPED_CATEGORY_REASON);
  });

  it('shows an Editor on Everything the working controls', () => {
    const html = settings({ canEditCategories: true });
    expect(html).toContain('New category');
    expect(html).toContain('title="Edit category"');
    expect(html).not.toContain(SCOPED_CATEGORY_REASON);
  });
});
