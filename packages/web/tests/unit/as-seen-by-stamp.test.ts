/**
 * The stamp data (#338): what `GET /api/dashboards/[id]` carries beside the definition so the "As seen by"
 * band and the numbers share one Access. The pure builder is tested here with hand-written expectations;
 * the route, and what each person gets from it, is in the access matrix.
 */
import { describe, expect, it } from 'vitest';
import { buildAsSeenByStamp, effectiveStampFilters } from '@/lib/as-seen-by';
import { buildAccess, everythingAccess, NO_ACCESS, parseScope, type Access } from '@/lib/access-model';
import { dateWindowLabelWithYear, formatDateKeyWithYear } from '@/lib/date-window';
import type { WidgetFilters } from '@/lib/dashboard-filters';
import type { DashboardConfig } from '@/lib/types';

const SUB_A = '00000000-0000-0000-0000-00000000000a';
const SUB_B = '00000000-0000-0000-0000-00000000000b';
const NOW = new Date('2026-06-10T12:00:00.000Z');
const WEEK: WidgetFilters = { dateWindow: { mode: 'relative', days: 7 } };

const holding = (...paths: string[]): Access =>
  buildAccess(paths.map(path => ({ tenantId: 't', scope: parseScope(path)!, role: 'viewer' as const })), 'manual');

const stamp = (access: Access, filters: WidgetFilters = WEEK, person: { name: string | null; email: string } = { name: 'Ada Example', email: 'ada@example.com' }) =>
  buildAsSeenByStamp({
    person, access, filters, now: NOW,
    categoryLabels: { security: 'Security', cost: 'Cost' },
    ruleNames: { 'rule-1': 'Storage must use TLS' },
  });

describe('the person', () => {
  it('is the display name', () => {
    expect(stamp(everythingAccess('admin')).person).toBe('Ada Example');
  });

  it('is the email when there is no name, or the name is blank', () => {
    expect(stamp(everythingAccess('admin'), WEEK, { name: null, email: 'ada@example.com' }).person).toBe('ada@example.com');
    expect(stamp(everythingAccess('admin'), WEEK, { name: '  ', email: 'ada@example.com' }).person).toBe('ada@example.com');
  });
});

describe('the access', () => {
  it('reads Everything, with no counts', () => {
    expect(stamp(everythingAccess('admin')).access).toEqual({ everything: true, counts: [], label: 'Everything' });
  });

  it('counts each kind in the fixed order, leaving empty kinds out', () => {
    const access = holding(
      `/subscriptions/${SUB_A}/resourceGroups/rg-one`,
      `/subscriptions/${SUB_B}`,
      '/providers/Microsoft.Management/managementGroups/mg-example',
      `/subscriptions/${SUB_A}`,
      `/subscriptions/${SUB_A}/resourceGroups/rg-two`,
      '@directory',
    );
    expect(stamp(access).access).toEqual({
      everything: false,
      counts: [
        { kind: 'directory', count: 1 },
        { kind: 'managementGroup', count: 1 },
        { kind: 'subscription', count: 2 },
        { kind: 'resourceGroup', count: 2 },
      ],
      label: '1 Directory, 1 management group, 2 subscriptions, 2 resource groups',
    });
    const some = stamp(holding(`/subscriptions/${SUB_A}`, `/subscriptions/${SUB_B}`)).access;
    expect(some.counts).toEqual([{ kind: 'subscription', count: 2 }]);
    expect(some.label).toBe('2 subscriptions');
  });

  it('counts a Scope held twice once, whatever its case', () => {
    const access = holding(`/subscriptions/${SUB_A}`, `/SUBSCRIPTIONS/${SUB_A.toUpperCase()}`);
    expect(stamp(access).access.counts).toEqual([{ kind: 'subscription', count: 1 }]);
  });

  it('reads No access for a person who holds nothing', () => {
    expect(stamp(NO_ACCESS).access).toEqual({ everything: false, counts: [], label: 'No access' });
  });

  it('never carries the Role', () => {
    expect(JSON.stringify(stamp(holding(`/subscriptions/${SUB_A}`)))).not.toMatch(/viewer|editor|admin/i);
  });
});

describe('the filters', () => {
  const filters: WidgetFilters = {
    ...WEEK,
    categories: ['security', 'unlisted'],
    ruleIds: ['rule-1'],
    subscriptions: [SUB_A, SUB_B],
    resourceGroups: ['rg-one', 'rg-secret'],
    tags: ['prod'],
    severities: ['critical', 'low'],
  };

  it('names each dimension in order with the values resolved on the server', () => {
    const { filters: shown } = stamp(everythingAccess('admin'), filters);
    expect(shown).toEqual([
      { dimension: 'category', values: ['Security', 'unlisted'], heldBack: 0 },
      { dimension: 'rule', values: ['Storage must use TLS'], heldBack: 0 },
      { dimension: 'subscription', values: [SUB_A, SUB_B], heldBack: 0 },
      { dimension: 'resourceGroup', values: ['rg-one', 'rg-secret'], heldBack: 0 },
      { dimension: 'tag', values: ['prod'], heldBack: 0 },
      { dimension: 'severity', values: ['Critical', 'Low'], heldBack: 0 },
    ]);
  });

  it('leaves out a dimension with nothing in it', () => {
    expect(stamp(everythingAccess('admin'), WEEK).filters).toEqual([]);
    expect(stamp(everythingAccess('admin'), { ...WEEK, tags: [], severities: [] }).filters).toEqual([]);
  });

  it('counts the values held back and names none of them', () => {
    const access = holding(`/subscriptions/${SUB_A}/resourceGroups/rg-one`);
    const result = stamp(access, filters);
    const subscription = result.filters.find(f => f.dimension === 'subscription')!;
    const resourceGroup = result.filters.find(f => f.dimension === 'resourceGroup')!;
    expect(subscription).toEqual({ dimension: 'subscription', values: [SUB_A], heldBack: 1 });
    expect(resourceGroup).toEqual({ dimension: 'resourceGroup', values: ['rg-one'], heldBack: 1 });
    const text = JSON.stringify(result);
    expect(text).not.toContain(SUB_B);
    expect(text).not.toContain('rg-secret');
  });

  it('keeps a dimension whose every value is held back, with an empty list and the count', () => {
    const result = stamp(holding('@directory'), { ...WEEK, subscriptions: [SUB_A] });
    expect(result.filters).toEqual([{ dimension: 'subscription', values: [], heldBack: 1 }]);
    expect(JSON.stringify(result)).not.toContain(SUB_A);
  });

  it('never holds back a category, rule, tag or severity', () => {
    const result = stamp(NO_ACCESS, { ...WEEK, categories: ['security'], tags: ['prod'], severities: ['high'], ruleIds: ['rule-1'] });
    expect(result.filters.map(f => f.heldBack)).toEqual([0, 0, 0, 0]);
  });
});

describe('the date window', () => {
  it('gives a relative window its label and the dates resolved for this response', () => {
    expect(stamp(everythingAccess('admin')).dateWindow).toEqual({ label: '7d', from: '2026-06-03', to: '2026-06-10' });
  });

  it('gives a custom range crossing a year both years, with the clamped dates', () => {
    const { dateWindow } = stamp(everythingAccess('admin'), { dateWindow: { mode: 'custom', from: '2025-12-20', to: '2026-01-05' } });
    expect(dateWindow).toEqual({ label: 'Dec 20, 2025 – Jan 5, 2026', from: '2025-12-20', to: '2026-01-05' });
  });

  it('reports the dates it clamped to, not the ones stored', () => {
    const { dateWindow } = stamp(everythingAccess('admin'), { dateWindow: { mode: 'custom', from: '2026-06-01', to: '2030-01-01' } });
    expect(dateWindow).toEqual({ label: 'Jun 1, 2026 – Jun 10, 2026', from: '2026-06-01', to: '2026-06-10' });
  });

  it('labels the dates it resolved when the range runs backwards', () => {
    const { dateWindow } = stamp(everythingAccess('admin'), { dateWindow: { mode: 'custom', from: '2026-02-01', to: '2026-01-01' } });
    expect(dateWindow).toEqual({ label: 'Jan 1, 2026 – Jan 1, 2026', from: '2026-01-01', to: '2026-01-01' });
  });
});

describe('formatDateKeyWithYear', () => {
  it('prints the year, and the label keeps the en dash', () => {
    expect(formatDateKeyWithYear('2025-12-20')).toBe('Dec 20, 2025');
    expect(dateWindowLabelWithYear({ mode: 'custom', from: '2025-12-20', to: '2026-01-05' })).toBe('Dec 20, 2025 – Jan 5, 2026');
    expect(dateWindowLabelWithYear({ mode: 'relative', days: 30 })).toBe('30d');
    expect(dateWindowLabelWithYear({ mode: 'custom', from: '2026-06-01', to: '2030-01-01' }, NOW)).toBe('Jun 1, 2026 – Jun 10, 2026');
  });
});

describe('the effective filters', () => {
  const config: DashboardConfig = {
    widgets: [],
    filters: { categories: ['security'], subscriptions: [SUB_A], tags: ['prod'] },
    dateWindow: { mode: 'relative', days: 30 },
  };
  const effective = (query: string) => effectiveStampFilters(config, new URLSearchParams(query));

  it('is the saved filters when the URL says nothing', () => {
    expect(effective('')).toEqual({
      categories: ['security'], subscriptions: [SUB_A], tags: ['prod'], dateWindow: { mode: 'relative', days: 30 },
    });
  });

  it('lets a dimension in the URL replace the saved one, and leaves the others as saved', () => {
    const result = effective(`category=cost,security&severity=high`);
    expect(result.categories).toEqual(['cost', 'security']);
    expect(result.severities).toEqual(['high']);
    expect(result.subscriptions).toEqual([SUB_A]);
    expect(result.tags).toEqual(['prod']);
  });

  it('lets an empty dimension in the URL clear the saved one', () => {
    expect(effective('tags=').tags).toBeUndefined();
    expect(effective('category=').categories).toBeUndefined();
  });

  it('reads rules, subscriptions and resource groups as the Scans address names them', () => {
    const result = effective(`ruleId=rule-1,rule-2&subscription=${SUB_B}&rg=rg-one`);
    expect(result.ruleIds).toEqual(['rule-1', 'rule-2']);
    expect(result.subscriptions).toEqual([SUB_B]);
    expect(result.resourceGroups).toEqual(['rg-one']);
  });

  it('takes the window from the URL, a custom range before a relative one', () => {
    expect(effective('window=1').dateWindow).toEqual({ mode: 'relative', days: 1 });
    expect(effective('from=2025-12-20&to=2026-01-05&window=1').dateWindow).toEqual({ mode: 'custom', from: '2025-12-20', to: '2026-01-05' });
  });

  it('ignores a window it cannot read and keeps the saved one', () => {
    expect(effective('window=abc').dateWindow).toEqual({ mode: 'relative', days: 30 });
    expect(effective('from=yesterday&to=today').dateWindow).toEqual({ mode: 'relative', days: 30 });
    expect(effective('from=2026-13-40&to=2026-01-01').dateWindow).toEqual({ mode: 'relative', days: 30 });
    expect(effective('from=2026-02-30&to=2026-03-01&window=1').dateWindow).toEqual({ mode: 'relative', days: 1 });
  });

  it('falls back to the legacy windowDays, then to seven days', () => {
    expect(effectiveStampFilters({ widgets: [], windowDays: 1 }, new URLSearchParams()).dateWindow).toEqual({ mode: 'relative', days: 1 });
    expect(effectiveStampFilters({ widgets: [] }, new URLSearchParams()).dateWindow).toEqual({ mode: 'relative', days: 7 });
  });
});
