/**
 * The Scans link of each widget number is built on the server from what the viewer holds (ADR 0013),
 * and a widget with nothing to count for the viewer says why instead of drawing a number. The link is
 * opened on the Scans read (`/api/findings/view`) to prove it holds the count the widget showed.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeFingerprint } from '@rulebeat/core';
import type { Rule } from '@rulebeat/core';
import { createUser } from '@/lib/db/users';
import { createDashboard } from '@/lib/db/dashboards';
import { replaceAssignmentsOn } from '@/lib/db/role-assignments';
import { inTransaction } from '@/lib/db/exec';
import { syncScanFindings } from '@/lib/db/findings';
import { saveRules } from '@/lib/rules';
import type { Finding, WidgetDef } from '@/lib/types';
import type { ViewResponse } from '@/lib/view-response';
import { clearRules, resetDb } from '../helpers/db';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const handlers: Record<string, { GET(req: Request): Promise<Response> }> = {};
const ROUTES = ['summary', 'findings', 'top-rules', 'top-resources', 'advisories'] as const;
const viewRoute = await import('@/app/api/findings/view/route');

const TENANT = '00000000-0000-0000-0000-0000000000f0';
const SUB_A = '00000000-0000-0000-0000-00000000000a';
const SUB_B = '00000000-0000-0000-0000-00000000000b';
const RULES = ['sl-rule-1', 'sl-rule-2', 'sl-rule-3'];

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
let everyoneId: string;
let scopedId: string;

beforeAll(async () => {
  for (const route of ROUTES) handlers[route] = await import(`@/app/api/widgets/${route}/route`);
});

beforeEach(async () => {
  await resetDb();
  await clearRules();
  await saveRules(RULES.map(rule));
  await syncScanFindings({
    scanId: 'sl-1', category: 'security', ranRuleIds: RULES, finishedAt: new Date().toISOString(),
    findings: [
      finding('sl-rule-1', 'vm-a1', SUB_A, 'critical'),
      finding('sl-rule-1', 'vm-a2', SUB_A, 'high'),
      finding('sl-rule-2', 'vm-a3', SUB_A, 'low'),
      finding('sl-rule-3', 'vm-b1', SUB_B, 'high'),
      finding('sl-rule-3', 'vm-b2', SUB_B, 'low'),
    ],
  });

  const created = await createDashboard({
    name: `links ${crypto.randomUUID()}`,
    config: {
      filters: { subscriptions: [SUB_A, SUB_B] },
      dateWindow: { mode: 'relative', days: 30 },
      widgets: [
        widget('open', 'stat-card', { metric: 'total-findings' }),
        widget('critical', 'stat-card', { metric: 'critical-findings' }),
        widget('ring', 'posture-ring'),
        widget('rules', 'top-rules'),
        widget('resources', 'top-resources'),
        widget('recent', 'recent-findings'),
        widget('only-a', 'stat-card', { metric: 'total-findings', subscriptions: [SUB_A] }),
        widget('only-a-rules', 'top-rules', { subscriptions: [SUB_A] }),
        widget('gone-category', 'stat-card', { metric: 'total-findings', category: 'removed-category' }),
        widget('gone-rule', 'stat-card', { metric: 'total-findings', policyIds: ['removed-rule'] }),
        widget('gone-tag', 'stat-card', { metric: 'total-findings', tags: ['removed-tag'] }),
        widget('half-gone', 'stat-card', { metric: 'total-findings', policyIds: ['removed-rule', 'sl-rule-1'] }),
      ],
    },
  });
  if (!created.ok) throw new Error(created.reason);
  dashboardId = created.dashboard.id;

  const person = async (email: string, role: 'viewer' | 'admin', scopes?: string[]) => {
    const made = await createUser({ email, role });
    if ('error' in made) throw new Error(made.error);
    if (scopes) await inTransaction(tx => replaceAssignmentsOn(tx, made.user.id, scopes.map(scope => ({ tenantId: TENANT, scope, role: 'viewer' as const }))));
    return made.user.id;
  };
  everyoneId = await person('everyone@example.com', 'admin');
  scopedId = await person('scoped@example.com', 'viewer', [`/subscriptions/${SUB_B}`]);
  mockAuth.mockReset();
  mockAuth.mockResolvedValue({ user: { uid: scopedId } });
});

/** The parts of a counting response these tests read. */
interface Row { href: string; count: number; name: string; ruleId: string }
interface WidgetAnswer {
  scansHref: string;
  revision?: number;
  heldBack?: unknown;
  noCount?: { kind: string; title: string };
  current: { activeFindings: number; severityCounts: Record<string, number> };
  items: Row[];
  perCategory: { category: string; href: string; activeFindings: number }[];
  perSubscription: { subscriptionId: string; href: string; activeFindings: number }[];
  severityHrefs: Record<string, string>;
}

async function ask(route: string, widgetId: string, extra = ''): Promise<WidgetAnswer> {
  const res = await handlers[route]!.GET(new Request(`http://localhost/api/widgets/${route}?dashboard=${dashboardId}&widget=${widgetId}${extra ? `&${extra}` : ''}`));
  expect(res.status).toBe(200);
  return res.json();
}

/** What opening `href` on Scans shows the viewer: the Scans read for the link's own params. */
async function opened(href: string): Promise<ViewResponse> {
  expect(href.startsWith('/scans?')).toBe(true);
  const res = await viewRoute.GET(new Request(`http://localhost/api/findings/view?${href.slice('/scans?'.length)}`));
  expect(res.status).toBe(200);
  return res.json();
}

describe('the Scans link of a number', () => {
  it('opens on Scans with the count the widget showed, and leaves out a subscription the viewer does not hold', async () => {
    const summary = await ask('summary', 'open');
    expect(summary.current.activeFindings).toBe(2);
    expect(summary.scansHref).not.toContain(SUB_A);
    expect(summary.scansHref).toContain(`subscription=${SUB_B}`);
    expect((await opened(summary.scansHref)).total).toBe(2);
  });

  it('is the whole filter for someone who holds every subscription it names', async () => {
    mockAuth.mockResolvedValue({ user: { uid: everyoneId } });
    const summary = await ask('summary', 'open');
    expect(summary.current.activeFindings).toBe(5);
    expect(summary.scansHref).toContain(SUB_A);
    expect(summary.scansHref).toContain(SUB_B);
    expect((await opened(summary.scansHref)).total).toBe(5);
  });

  it('carries the metric of a stat card', async () => {
    const summary = await ask('summary', 'critical');
    const href = new URL(summary.scansHref, 'http://localhost');
    expect(href.searchParams.get('severity')).toBe('critical');
  });

  it('is on every row of a list and holds the row\'s count', async () => {
    const rules = await ask('top-rules', 'rules');
    expect(rules.items.length).toBeGreaterThan(0);
    for (const item of rules.items) {
      expect(item.href).not.toContain(SUB_A);
      expect((await opened(item.href)).total, item.name).toBe(item.count);
    }
    const recent = await ask('findings', 'recent');
    for (const item of recent.items) {
      expect(item.href).toContain(`ruleId=${item.ruleId}`);
      expect(item.href).not.toContain(SUB_A);
    }
    const resources = await ask('top-resources', 'resources');
    for (const item of resources.items) expect(item.href).not.toContain(SUB_A);
  });

  it('is on every category, subscription and severity of the summary', async () => {
    const summary = await ask('summary', 'ring');
    const security = summary.perCategory.find(c => c.category === 'security')!;
    expect(security.href).toContain('category=security');
    expect((await opened(security.href)).total).toBe(security.activeFindings);
    expect(summary.perSubscription.map(s => s.subscriptionId)).toEqual([SUB_B]);
    for (const sub of summary.perSubscription) expect((await opened(sub.href)).total).toBe(sub.activeFindings);
    expect(summary.severityHrefs.high).toContain('severity=high');
    expect((await opened(summary.severityHrefs.high)).total).toBe(summary.current.severityCounts.high);
  });

  it('never names a subscription outside the viewer\'s access anywhere in a response', async () => {
    const widgetOf = { summary: 'open', findings: 'recent', 'top-rules': 'rules', 'top-resources': 'resources', advisories: 'recent' };
    for (const route of ROUTES) {
      expect(JSON.stringify(await ask(route, widgetOf[route])), route).not.toContain(SUB_A);
    }
  });
});

describe('a widget whose subscription is entirely outside the viewer\'s access', () => {
  it.each([['summary', 'only-a'], ['top-rules', 'only-a-rules']])('%s shows no number and no link', async (route, widgetId) => {
    const body = await ask(route, widgetId);
    expect(body.noCount).toMatchObject({ kind: 'outside-access', title: 'Outside your access' });
    expect(Object.keys(body).sort()).toEqual(['heldBack', 'noCount', 'revision']);
    expect(JSON.stringify(body)).not.toContain(SUB_A);
  });

  it('counts normally for someone who holds it', async () => {
    mockAuth.mockResolvedValue({ user: { uid: everyoneId } });
    const body = await ask('summary', 'only-a');
    expect(body.noCount).toBeUndefined();
    expect(body.current.activeFindings).toBe(3);
  });
});

describe('a widget whose values for a dimension are all gone', () => {
  it.each([
    ['category', 'gone-category'],
    ['rule', 'gone-rule'],
    ['tags', 'gone-tag'],
  ])('says why it has nothing to count when the %s no longer exists', async (_dimension, widgetId) => {
    const body = await ask('summary', widgetId);
    expect(body.noCount!.kind).toBe('gone');
    expect(body.noCount!.title).not.toBe('Outside your access');
    expect(body.current).toBeUndefined();
    expect(body.scansHref).toBeUndefined();
  });

  it('counts the values that do exist when only some are gone', async () => {
    const body = await ask('summary', 'half-gone');
    expect(body.noCount).toBeUndefined();
    expect(body.current.activeFindings).toBe(0);
  });

  it('answers every counting route the same way', async () => {
    for (const route of ROUTES) {
      const body = await ask(route, 'gone-category');
      expect(body.noCount?.kind, route).toBe('gone');
    }
  });
});
