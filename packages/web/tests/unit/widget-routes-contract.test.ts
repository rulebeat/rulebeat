/**
 * The contract of every counting widget route (ADR 0013): it takes the dashboard id, the widget id and
 * the filter changes, and answers with the revision it computed from. It refuses assembled filter
 * params, takes a row limit or trend length only from the widget's stored config (the request's own is
 * read in an edit-mode preview alone), and answers 404 for a dashboard or widget that does not exist.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeFingerprint } from '@rulebeat/core';
import type { Rule } from '@rulebeat/core';
import { createUser } from '@/lib/db/users';
import { createDashboard, updateDashboard } from '@/lib/db/dashboards';
import { replaceAssignmentsOn } from '@/lib/db/role-assignments';
import { inTransaction } from '@/lib/db/exec';
import { syncScanFindings } from '@/lib/db/findings';
import { saveRules } from '@/lib/rules';
import { readWidgetRequest } from '@/lib/widget-request';
import { everythingAccess } from '@/lib/access-model';
import type { Finding, WidgetDef } from '@/lib/types';
import { clearRules, resetDb } from '../helpers/db';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const ROUTES = ['summary', 'findings', 'top-rules', 'top-resources', 'advisories'] as const;
type Route = (typeof ROUTES)[number];
const handlers: Record<string, { GET(req: Request): Promise<Response> }> = {};

const TENANT = '00000000-0000-0000-0000-0000000000f0';
const SUB_A = '00000000-0000-0000-0000-00000000000a';
const SUB_B = '00000000-0000-0000-0000-00000000000b';
const RULES = ['wr-rule-1', 'wr-rule-2', 'wr-rule-3'];
const DAY = 86_400_000;

function rule(id: string): Rule {
  return {
    id, name: `rule ${id}`, description: 'test', category: 'security', severity: 'medium', enabled: true,
    type: 'custom', scope: { level: 'subscription' }, resourceTypes: [], conditions: [],
  };
}

function finding(ruleId: string, name: string, subscriptionId: string, severity: Finding['severity'] = 'medium'): Finding {
  const resourceId = `/subscriptions/${subscriptionId}/resourceGroups/rg-1/providers/Microsoft.Compute/virtualMachines/${name}`;
  return {
    module: 'security', category: 'security', ruleId, fingerprint: computeFingerprint(ruleId, resourceId),
    resourceId, resourceType: 'microsoft.compute/virtualmachines', resourceName: name, subscriptionId,
    title: 'finding', description: 'test', evidence: {}, recommendation: 'fix', remediationSteps: [],
    detectedAt: new Date().toISOString(), severity,
  };
}

function widget(id: string, type: string, config: Record<string, unknown> = {}): WidgetDef {
  return { id, type, title: id, x: 0, y: 0, w: 4, h: 4, config } as WidgetDef;
}

let dashboardId: string;
let revision: number;
let viewerId: string;
let editorId: string;
let scopedId: string;

async function person(email: string, role: 'viewer' | 'editor', scopes?: string[]): Promise<string> {
  const created = await createUser({ email, role });
  if ('error' in created) throw new Error(created.error);
  if (scopes) await inTransaction(tx => replaceAssignmentsOn(tx, created.user.id, scopes.map(scope => ({ tenantId: TENANT, scope, role }))));
  return created.user.id;
}

beforeAll(async () => {
  for (const route of [...ROUTES, 'filter-options', 'rules']) handlers[route] = await import(`@/app/api/widgets/${route}/route`);
});

beforeEach(async () => {
  await resetDb();
  await clearRules();
  await saveRules(RULES.map(rule));
  const found = [
    finding('wr-rule-1', 'vm-a1', SUB_A, 'critical'),
    finding('wr-rule-1', 'vm-a2', SUB_A, 'high'),
    finding('wr-rule-2', 'vm-a3', SUB_A, 'low'),
    finding('wr-rule-3', 'vm-b1', SUB_B, 'high'),
    finding('wr-rule-3', 'vm-b2', SUB_B, 'low'),
  ];
  // The first scan ran 20 days ago, so its events sit outside a 7 day period and inside a 90 day one.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() - 20 * DAY);
  await syncScanFindings({ scanId: 'wr-1', category: 'security', ranRuleIds: RULES, findings: found, finishedAt: new Date().toISOString() });
  vi.useRealTimers();
  await syncScanFindings({ scanId: 'wr-2', category: 'security', ranRuleIds: RULES, findings: found.slice(1), finishedAt: new Date(Date.now() - DAY).toISOString() });

  const created = await createDashboard({
    name: `routes ${crypto.randomUUID()}`,
    config: {
      filters: { subscriptions: [SUB_A, SUB_B] },
      dateWindow: { mode: 'relative', days: 30 },
      widgets: [
        widget('summary', 'stat-card'),
        widget('rules', 'top-rules', { limit: 1 }),
        widget('resources', 'top-resources', { limit: 1 }),
        widget('recent', 'recent-findings', { limit: 2 }),
        widget('advisories', 'advisories', { limit: 1 }),
        widget('fixed', 'new-vs-fixed', { period: '7d' }),
        widget('scoped', 'top-rules', { subscriptions: [SUB_A] }),
        widget('fixed-year', 'new-vs-fixed', { period: '365d' }),
        widget('activity-all', 'activity-occurrences', { period: 'all' }),
        widget('trend-year', 'trend', { period: '365d' }),
        widget('trend-all', 'trend', { period: 'all' }),
      ],
    },
  });
  if (!created.ok) throw new Error(created.reason);
  dashboardId = created.dashboard.id;
  revision = created.dashboard.revision;

  viewerId = await person('viewer@example.com', 'viewer');
  editorId = await person('editor@example.com', 'editor');
  scopedId = await person('scoped@example.com', 'viewer', [`/subscriptions/${SUB_B}`]);
  mockAuth.mockReset();
  mockAuth.mockResolvedValue({ user: { uid: viewerId } });
});

const ROUTE_WIDGET: Record<Route, string> = {
  summary: 'summary', findings: 'recent', 'top-rules': 'rules', 'top-resources': 'resources', advisories: 'advisories',
};

async function ask(route: string, query: string): Promise<Response> {
  return handlers[route]!.GET(new Request(`http://localhost/api/widgets/${route}?${query}`));
}
const asking = (route: Route, widgetId = ROUTE_WIDGET[route], extra = '') =>
  ask(route, `dashboard=${dashboardId}&widget=${widgetId}${extra ? `&${extra}` : ''}`);
const itemsOf = async (res: Response) => (await res.json() as { items: { name?: string; resourceName?: string }[] }).items;

describe('assembled filter params', () => {
  it.each(ROUTES)('%s answers 400 to the params a client used to assemble', async route => {
    for (const assembled of ['categories=security&window=7', 'subscriptions=x', 'resourceGroups=rg-1', 'severities=high', 'ruleIds=r', 'policyIds=r', 'suppressed=1', 'includeSuppressed=1']) {
      expect((await asking(route, ROUTE_WIDGET[route], assembled)).status, assembled).toBe(400);
    }
  });

  it.each(ROUTES)('%s answers 400 without a dashboard and a widget', async route => {
    expect((await ask(route, '')).status).toBe(400);
    expect((await ask(route, `dashboard=${dashboardId}`)).status).toBe(400);
    expect((await ask(route, `widget=${ROUTE_WIDGET[route]}`)).status).toBe(400);
  });

  it('keeps the shape of the option lists', async () => {
    const options = await (await handlers['filter-options']!.GET(new Request('http://localhost/api/widgets/filter-options'))).json();
    expect(Object.keys(options).sort()).toEqual(['categories', 'resourceGroups', 'rules', 'subscriptions', 'tags']);
    const rules = await (await handlers['rules']!.GET(new Request('http://localhost/api/widgets/rules'))).json() as { id: string }[];
    expect(rules.map(r => r.id)).toEqual(expect.arrayContaining(RULES));
  });
});

describe('which dashboard and widget', () => {
  it.each(ROUTES)('%s answers 404 for a dashboard that does not exist', async route => {
    expect((await ask(route, `dashboard=nope&widget=${ROUTE_WIDGET[route]}`)).status).toBe(404);
  });

  it.each(ROUTES)('%s answers 404 for a widget the dashboard does not hold', async route => {
    expect((await asking(route, 'nope')).status).toBe(404);
  });

  it.each(ROUTES)('%s answers with the revision it computed from', async route => {
    const first = await (await asking(route)).json() as { revision: number };
    expect(first.revision).toBe(revision);
    await updateDashboard(dashboardId, { description: 'saved again' });
    expect(((await (await asking(route)).json()) as { revision: number }).revision).toBe(revision + 1);
  });
});

describe('the numbers', () => {
  it('count the saved filters, and a change replaces one dimension of them', async () => {
    const all = await (await asking('summary')).json() as { current: { activeFindings: number } };
    expect(all.current.activeFindings).toBe(4);
    const one = await (await asking('summary', 'summary', `subscription=${SUB_A}`)).json() as { current: { activeFindings: number } };
    expect(one.current.activeFindings).toBe(2);
  });

  it('count the widget\'s own override over a change, without intersecting', async () => {
    const res = await asking('top-rules', 'scoped', `subscription=${SUB_B}`);
    expect(((await itemsOf(res)) as { name: string }[]).map(i => i.name)).toEqual(expect.arrayContaining(['rule wr-rule-1']));
  });

  it('leave a subscription outside the viewer\'s access out of the numbers and report it as a count', async () => {
    mockAuth.mockResolvedValue({ user: { uid: scopedId } });
    const res = await asking('summary', 'summary', `subscription=${SUB_A},${SUB_B}`);
    const body = await res.json() as { current: { activeFindings: number }; heldBack: number };
    expect(body.current.activeFindings).toBe(2);
    expect(body.heldBack).toBe(1);
    expect(JSON.stringify(body)).not.toContain(SUB_A);
  });

  it('give the same changes the numbers of whoever reads them', async () => {
    const query = `subscription=${SUB_A},${SUB_B}`;
    const asM = await (await asking('summary', 'summary', query)).json() as { current: { activeFindings: number }; heldBack: number };
    mockAuth.mockResolvedValue({ user: { uid: scopedId } });
    const asL = await (await asking('summary', 'summary', query)).json() as { current: { activeFindings: number }; heldBack: number };
    expect([asM.current.activeFindings, asM.heldBack]).toEqual([4, 0]);
    expect([asL.current.activeFindings, asL.heldBack]).toEqual([2, 1]);
  });
});

describe('limits and trend length', () => {
  it('read the stored limit and ignore the request\'s outside a preview', async () => {
    expect(await itemsOf(await asking('top-rules', 'rules', 'limit=3'))).toHaveLength(1);
    expect(await itemsOf(await asking('top-resources', 'resources', 'limit=3'))).toHaveLength(1);
    expect(await itemsOf(await asking('findings', 'recent', 'limit=3'))).toHaveLength(2);
    expect(((await (await asking('advisories', 'advisories', 'limit=3')).json()) as { items: unknown[] }).items.length).toBeLessThanOrEqual(1);
  });

  it('read the stored period and ignore the request\'s trendDays outside a preview', async () => {
    const trend = async (extra: string) => ((await (await asking('summary', 'fixed', extra)).json()) as { newVsFixedTrend: unknown[] }).newVsFixedTrend;
    const week = await trend('trendDays=90');
    expect(week.every(day => (day as { created: number }).created === 0)).toBe(true);
  });
});

describe('the trend length of a stored period', () => {
  const trendDaysOf = async (widgetId: string) => {
    const read = await readWidgetRequest(
      new Request(`http://localhost/api/widgets/summary?dashboard=${dashboardId}&widget=${widgetId}`),
      (await import('@/lib/access-model')).everythingAccess('viewer'),
    );
    if (read instanceof Response) throw new Error(`refused with ${read.status}`);
    return read.trendDays;
  };

  it('counts at most 180 days for new-vs-fixed and activity occurrences, whose events are kept 180 days', async () => {
    expect(await trendDaysOf('fixed-year')).toBe(180);
    expect(await trendDaysOf('activity-all')).toBe(180);
  });

  it('counts up to a year for the posture trend, and a week for a stored 7d', async () => {
    expect(await trendDaysOf('trend-year')).toBe(365);
    expect(await trendDaysOf('trend-all')).toBe(365);
    expect(await trendDaysOf('fixed')).toBe(7);
  });

  it('counts 30 days for a widget with no trend of its own', async () => {
    expect(await trendDaysOf('summary')).toBe(30);
  });
});

describe('preview', () => {
  const draft = (config: object) => `preview=1&draft=${encodeURIComponent(JSON.stringify(config))}`;

  it('is refused without the edit right', async () => {
    expect((await asking('top-rules', 'rules', draft({ limit: 5 }))).status).toBe(403);
  });

  it('is refused when the draft is not a JSON object', async () => {
    mockAuth.mockResolvedValue({ user: { uid: editorId } });
    expect((await asking('top-rules', 'rules', 'preview=1&draft=%5B%5D')).status).toBe(400);
    expect((await asking('top-rules', 'rules', 'preview=1')).status).toBe(400);
  });

  it('counts the draft config and reads the request\'s limit and trendDays', async () => {
    mockAuth.mockResolvedValue({ user: { uid: editorId } });
    expect(await itemsOf(await asking('top-rules', 'rules', `limit=3&${draft({ limit: 1 })}`))).toHaveLength(3);
    const narrowed = await itemsOf(await asking('top-rules', 'rules', draft({ subscriptions: [SUB_A] })));
    expect(narrowed.map(i => i.name).sort()).toEqual(['rule wr-rule-1', 'rule wr-rule-2']);
    const trend = ((await (await asking('summary', 'fixed', `trendDays=90&${draft({ period: '90d' })}`)).json()) as { newVsFixedTrend: unknown[] }).newVsFixedTrend;
    expect((trend as { created: number }[]).reduce((sum, day) => sum + day.created, 0)).toBe(5);
  });

  it('previews a widget that is not saved yet', async () => {
    mockAuth.mockResolvedValue({ user: { uid: editorId } });
    expect((await asking('top-rules', 'brand-new', draft({ category: 'security' }))).status).toBe(200);
  });
});

describe('the trend cap of a widget that is not saved yet', () => {
  it('follows the type the preview names', async () => {
    const read = async (type: string) => {
      const out = await readWidgetRequest(
        new Request(`http://localhost/api/widgets/summary?dashboard=${dashboardId}&widget=fresh&preview=1&draft=%7B%7D&trendDays=365&type=${type}`),
        everythingAccess('editor'),
      );
      if (out instanceof Response) throw new Error(`refused with ${out.status}`);
      return out.trendDays;
    };
    expect(await read('new-vs-fixed')).toBe(180);
    expect(await read('trend')).toBe(365);
  });
});
