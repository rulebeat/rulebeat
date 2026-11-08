/**
 * The effective filters of a dashboard widget (ADR 0013): the saved filters, then the filter changes
 * from the address, then the widget's own override, each replacing the one before for a dimension it
 * sets. A value the viewer's access does not reach stays in the filter (so it never widens) and is
 * reported as a count.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { effectiveFilters } from '@/lib/effective-filters';
import { createDashboard, updateDashboard } from '@/lib/db/dashboards';
import { buildAccess, everythingAccess, type Access } from '@/lib/access-model';
import type { DashboardConfig, WidgetDef } from '@/lib/types';
import { EVERYTHING_ACCESS } from '../helpers/access';

const SUB_A = '00000000-0000-0000-0000-00000000000a';
const SUB_B = '00000000-0000-0000-0000-00000000000b';

function widget(id: string, config: Record<string, unknown> = {}): WidgetDef {
  return { id, type: 'top-rules', title: id, x: 0, y: 0, w: 4, h: 4, config };
}

let counter = 0;
async function dashboardWith(config: Partial<DashboardConfig>): Promise<string> {
  const created = await createDashboard({
    name: `effective filters ${++counter} ${crypto.randomUUID()}`,
    config: { widgets: [widget('plain'), widget('own', { severities: ['low'], subscriptions: [SUB_B] })], ...config },
  });
  if (!created.ok) throw new Error(created.reason);
  return created.dashboard.id;
}

const viewerOf = (...subscriptions: string[]): Access => buildAccess(
  subscriptions.map(id => ({ tenantId: 't', scope: { kind: 'subscription' as const, path: `/subscriptions/${id}` }, role: 'viewer' as const })),
  'manual',
);

let id: string;
beforeEach(async () => {
  id = await dashboardWith({
    filters: { subscriptions: [SUB_A, SUB_B], categories: ['security'] },
    dateWindow: { mode: 'relative', days: 30 },
  });
});

async function ok(input: Parameters<typeof effectiveFilters>[0]) {
  const result = await effectiveFilters(input);
  if (!result.ok) throw new Error(result.reason);
  return result;
}

describe('assembling the layers', () => {
  it('keeps the saved subscriptions when the changes name only a severity', async () => {
    const { filters } = await ok({ dashboardId: id, widgetId: 'plain', changes: new URLSearchParams('severity=high'), access: EVERYTHING_ACCESS });
    expect(filters.subscriptions).toEqual([SUB_A, SUB_B]);
    expect(filters.severities).toEqual(['high']);
    expect(filters.categories).toEqual(['security']);
    expect(filters.dateWindow).toEqual({ mode: 'relative', days: 30 });
  });

  it('replaces a saved dimension with the change, and reads an empty change as any', async () => {
    const { filters } = await ok({ dashboardId: id, widgetId: 'plain', changes: new URLSearchParams(`subscription=${SUB_A}&category=&window=7`), access: EVERYTHING_ACCESS });
    expect(filters.subscriptions).toEqual([SUB_A]);
    expect(filters.categories).toBeUndefined();
    expect(filters.dateWindow).toEqual({ mode: 'relative', days: 7 });
  });

  it('lets the widget override replace a change instead of intersecting it', async () => {
    const { filters } = await ok({ dashboardId: id, widgetId: 'own', changes: new URLSearchParams(`severity=high&subscription=${SUB_A}`), access: EVERYTHING_ACCESS });
    expect(filters.severities).toEqual(['low']);
    expect(filters.subscriptions).toEqual([SUB_B]);
  });

  it('falls back to the legacy window and then to 7 days when the dashboard saved none', async () => {
    const legacy = await dashboardWith({ windowDays: 1 });
    expect((await ok({ dashboardId: legacy, widgetId: 'plain', changes: new URLSearchParams(), access: EVERYTHING_ACCESS })).filters.dateWindow).toEqual({ mode: 'relative', days: 1 });
    const bare = await dashboardWith({});
    expect((await ok({ dashboardId: bare, widgetId: 'plain', changes: new URLSearchParams(), access: EVERYTHING_ACCESS })).filters.dateWindow).toEqual({ mode: 'relative', days: 7 });
  });

  it('answers with the revision it computed from', async () => {
    const before = await ok({ dashboardId: id, widgetId: 'plain', changes: new URLSearchParams(), access: EVERYTHING_ACCESS });
    await updateDashboard(id, { description: 'changed' });
    const after = await ok({ dashboardId: id, widgetId: 'plain', changes: new URLSearchParams(), access: EVERYTHING_ACCESS });
    expect(after.revision).toBe(before.revision + 1);
  });

  it('refuses a dashboard or a widget that does not exist', async () => {
    expect(await effectiveFilters({ dashboardId: 'nope', widgetId: 'plain', changes: new URLSearchParams(), access: EVERYTHING_ACCESS })).toEqual({ ok: false, reason: 'not-found' });
    expect(await effectiveFilters({ dashboardId: id, widgetId: 'nope', changes: new URLSearchParams(), access: EVERYTHING_ACCESS })).toEqual({ ok: false, reason: 'not-found' });
  });
});

describe('values the viewer cannot use', () => {
  it('keeps a value outside the viewer\'s access in the filter and counts it', async () => {
    const changes = new URLSearchParams(`subscription=${SUB_A},${SUB_B}`);
    const forL = await ok({ dashboardId: id, widgetId: 'plain', changes, access: viewerOf(SUB_B) });
    expect(forL.filters.subscriptions).toEqual([SUB_A, SUB_B]);
    expect(forL.heldBack).toBe(1);
  });

  it('counts nothing for a person who holds every value', async () => {
    const forM = await ok({ dashboardId: id, widgetId: 'plain', changes: new URLSearchParams(`subscription=${SUB_A},${SUB_B}`), access: EVERYTHING_ACCESS });
    expect(forM.heldBack).toBe(0);
  });

  it('evaluates one person\'s changes for another with identical filters and that other person\'s own count', async () => {
    const changes = new URLSearchParams(`subscription=${SUB_A}&severity=critical`);
    const forL = await ok({ dashboardId: id, widgetId: 'plain', changes, access: viewerOf(SUB_B) });
    const forM = await ok({ dashboardId: id, widgetId: 'plain', changes, access: everythingAccess('viewer') });
    expect(forM.filters).toEqual(forL.filters);
    expect([forL.heldBack, forM.heldBack]).toEqual([1, 0]);
  });
});

describe('preview', () => {
  const EDITOR = everythingAccess('editor');

  it('is refused without the edit right', async () => {
    const result = await effectiveFilters({
      dashboardId: id, widgetId: 'plain', changes: new URLSearchParams(), access: everythingAccess('viewer'), preview: { config: { severities: ['high'] } },
    });
    expect(result).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('uses the draft in place of the stored widget, even for a widget that is not saved yet', async () => {
    const stored = await ok({ dashboardId: id, widgetId: 'own', changes: new URLSearchParams(), access: EDITOR });
    expect(stored.filters.severities).toEqual(['low']);
    const draft = await ok({ dashboardId: id, widgetId: 'own', changes: new URLSearchParams(), access: EDITOR, preview: { config: { severities: ['high'], limit: 3 } } });
    expect(draft.filters.severities).toEqual(['high']);
    expect(draft.config).toEqual({ severities: ['high'], limit: 3 });
    const fresh = await ok({ dashboardId: id, widgetId: 'brand-new', changes: new URLSearchParams(), access: EDITOR, preview: { config: { category: 'cost' } } });
    expect(fresh.filters.categories).toEqual(['cost']);
  });

  it('merges back the held-back values of the stored override into the draft', async () => {
    // An edit right with a narrower reach than Everything is what RULEBEAT-4's owned dashboards allow;
    // today's roles cannot hold one, so the access is written by hand.
    const narrowEditor: Access = {
      ...buildAccess([...everythingAccess('editor').grants, ...viewerOf(SUB_A).grants], 'manual'), everything: false,
    };
    const result = await ok({
      dashboardId: id, widgetId: 'own', changes: new URLSearchParams(), access: narrowEditor, preview: { config: { subscriptions: [SUB_A] } },
    });
    // The stored override names SUB_B, which this editor cannot see, so the draft cannot have dropped it.
    expect(result.filters.subscriptions).toEqual([SUB_A, SUB_B]);
    expect(result.heldBack).toBe(1);
  });
});
