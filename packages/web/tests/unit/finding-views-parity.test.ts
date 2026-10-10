/**
 * ADR 0007: the view routes answer from the database, and what they answer is exactly
 * what the explorer computes over every finding today. `buildViewResponse` and its three siblings
 * (lib/view-response.ts) are the pure reference: they take every finding with all its rows. Each
 * route is held to that reference over one fixture, for a table of views, byte for byte.
 *
 * The fixture is stored through runCategoryScan() over the fake Azure context, so the findings,
 * rows, column catalogue and ages are what a real scan leaves: several rules and kinds, findings
 * with many rows and with nested and empty values, several subscriptions, groups, locations and
 * tags, a Fixed finding, a suppressed finding, a rule that is gone, and ages spread over days.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { computeFingerprint } from '@rulebeat/core';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { rules as rulesTable } from '@/lib/db/tables';
import { getCategory } from '@/lib/db/categories';
import { listFindings } from '@/lib/db/findings';
import { queryFilterOptions } from '@/lib/db/finding-views';
import { addSuppression } from '@/lib/suppressions';
import { runCategoryScan } from '@/lib/scan-runner';
import { emptyView, viewToSearchParams, type View, type ViewFilter } from '@/lib/finding-view';
import {
  buildColumnValuesResponse, buildFindingRowsResponse, buildGroupResponse, buildViewResponse,
  type ColumnValuesResponse, type FindingRowsResponse, type GroupResponse, type ViewResponse, type ViewTab,
} from '@/lib/view-response';
import { resetDb } from '../helpers/db';
import { referenceInputs, wire } from '../helpers/view-reference';
import { argRow, fakeTenantContext, TEST_SUB_A, TEST_SUB_B } from '../helpers/fake-azure';

const mockRequireRole = vi.fn();
vi.mock('@/lib/api-auth', () => ({ requireRole: (...args: unknown[]) => mockRequireRole(...args) }));
const viewRoute = await import('@/app/api/findings/view/route');
const rowsRoute = await import('@/app/api/findings/rows/route');
const groupRoute = await import('@/app/api/findings/group/route');
const columnValuesRoute = await import('@/app/api/findings/column-values/route');

// ---- The fixture ----

const NOW = Date.now();
const DAY = 86_400_000;
const AT = { T0: NOW - 20 * DAY, T1: NOW - 3 * DAY, T2: NOW - 0.5 * DAY } as const;
type Moment = keyof typeof AT;
const dayKey = (moment: Moment) => new Date(AT[moment]).toISOString().slice(0, 10);

interface Resource { name: string; sub?: string; rg?: string; location?: string; rows: Record<string, unknown>[] }
const vm = (name: string, rows: Record<string, unknown>[], rest: Partial<Resource> = {}): Resource => ({ name, rows, ...rest });

const MANY_ROWS = Array.from({ length: 25 }, (_, i) => ({ item: i, properties: { sku: { name: i % 2 ? 'S1' : 'S2' } } }));
const BULK = Array.from({ length: 60 }, (_, i) => vm(`bulk-${String(i).padStart(3, '0')}`, [
  { batch: i % 3, properties: { sku: { name: i % 2 ? 'S1' : 'S2' } } },
], { sub: i % 3 === 0 ? TEST_SUB_B : TEST_SUB_A, rg: `rg-bulk-${i % 4}`, location: i % 5 === 0 ? 'northeurope' : 'westeurope' }));

const ALPHA_ROWS = [
  { retirement: 'Basic tier', properties: { sku: { name: 'S1' }, tier: 'Basic' }, zone: '1', link: 'https://docs.example/basic', count: 3 },
  { retirement: 'TLS 1.0', properties: { sku: { name: 'S2' } }, zone: '2', empty: '' },
];

interface RulePlan { name: string; category: 'security' | 'cost' | 'reliability'; severity: string; kind: 'state' | 'advisory'; tags?: string[]; group?: string; at: Partial<Record<Moment, Resource[]>> }
const ARG_RULES: Record<string, RulePlan> = {
  'sec-high': {
    name: 'Basic tier retirements', category: 'security', severity: 'high', kind: 'state',
    at: {
      T0: [vm('vm-alpha', ALPHA_ROWS, { rg: 'rg-a', location: 'westeurope' }), vm('vm-bravo', [{}], { sub: TEST_SUB_B, rg: 'rg-b', location: 'northeurope' }), vm('vm-charlie', [{ zone: '3' }], { rg: 'rg-a' })],
      T1: [vm('vm-alpha', ALPHA_ROWS, { rg: 'rg-a', location: 'westeurope' }), vm('vm-bravo', [{}], { sub: TEST_SUB_B, rg: 'rg-b', location: 'northeurope' }), vm('vm-delta', MANY_ROWS, { rg: 'rg-b' })],
      T2: [vm('vm-alpha', ALPHA_ROWS, { rg: 'rg-a', location: 'westeurope' }), vm('vm-bravo', [{}], { sub: TEST_SUB_B, rg: 'rg-b', location: 'northeurope' }), vm('vm-delta', MANY_ROWS, { rg: 'rg-b' })],
    },
  },
  'sec-critical': {
    name: 'Critical exposure', category: 'security', severity: 'critical', kind: 'state',
    at: {
      T0: [vm('vm-alpha', [{ zone: '1' }], { rg: 'rg-a', location: 'westeurope' })],
      T1: [vm('vm-alpha', [{ zone: '1' }], { rg: 'rg-a', location: 'westeurope' }), vm('VM-ECHO', [{ nested: { deep: { deeper: { deepest: 1 } } }, list: [1, 2], flag: true, nul: null }], { sub: TEST_SUB_B, rg: '', location: '' })],
      T2: [vm('vm-alpha', [{ zone: '1' }], { rg: 'rg-a', location: 'westeurope' }), vm('VM-ECHO', [{ nested: { deep: { deeper: { deepest: 1 } } }, list: [1, 2], flag: true, nul: null }], { sub: TEST_SUB_B, rg: '', location: '' })],
    },
  },
  'cost-medium': {
    name: 'Premium disks', category: 'cost', severity: 'medium', kind: 'state', tags: ['finops', 'prod'],
    at: {
      T0: [vm('vm-fox', [{ sku: 'Premium', savings: 12.5 }], { rg: 'rg-c', location: 'eastus' }), vm('vm-golf', [{ sku: 'Standard', savings: 3 }], { sub: TEST_SUB_B, rg: 'rg-c', location: 'eastus' })],
      T1: [vm('vm-fox', [{ sku: 'Premium', savings: 12.5 }], { rg: 'rg-c', location: 'eastus' }), vm('vm-golf', [{ sku: 'Standard', savings: 3 }], { sub: TEST_SUB_B, rg: 'rg-c', location: 'eastus' })],
      T2: [vm('vm-fox', [{ sku: 'Premium', savings: 12.5 }], { rg: 'rg-c', location: 'eastus' }), vm('vm-golf', [{ sku: 'Standard', savings: 3 }], { sub: TEST_SUB_B, rg: 'rg-c', location: 'eastus' })],
    },
  },
  'cost-low': {
    name: 'Idle gateways', category: 'cost', severity: 'low', kind: 'state', group: 'ops',
    at: {
      T1: [vm('vm-hotel', [{ sku: 'Basic' }], { rg: 'rg-c', location: 'westeurope' })],
      T2: [vm('vm-hotel', [{ sku: 'Basic' }], { rg: 'rg-c', location: 'westeurope' })],
    },
  },
  'cost-bulk': {
    // Tagged by the old single `group` column only, which a rule's tags fall back to.
    name: 'Bulk tagging', category: 'cost', severity: 'low', kind: 'state', group: 'bulkgrp',
    at: { T1: BULK, T2: BULK },
  },
  'adv-retire': {
    name: 'Service retirements', category: 'reliability', severity: 'medium', kind: 'advisory',
    at: {
      T0: [vm('vm-alpha', [{ retirement: 'Basic tier', retiresOn: '2026-12-01' }, { retirement: 'Gen1 images', retiresOn: '2027-03-01' }], { rg: 'rg-a', location: 'westeurope' }), vm('vm-ivy', [{ retirement: 'TLS 1.0', retiresOn: '2026-12-01' }], { sub: TEST_SUB_B, rg: 'rg-d', location: 'northeurope' })],
      T2: [vm('vm-alpha', [{ retirement: 'Basic tier', retiresOn: '2026-12-01' }, { retirement: 'Gen1 images', retiresOn: '2027-03-01' }], { rg: 'rg-a', location: 'westeurope' }), vm('vm-ivy', [{ retirement: 'TLS 1.0', retiresOn: '2026-12-01' }], { sub: TEST_SUB_B, rg: 'rg-d', location: 'northeurope' })],
    },
  },
  'adv-sku': {
    name: 'SKU changes', category: 'reliability', severity: 'low', kind: 'advisory',
    at: {
      T1: [vm('vm-ivy', [{ retirement: 'Basic tier', retiresOn: '2027-01-01' }], { sub: TEST_SUB_B, rg: 'rg-d', location: 'northeurope' }), vm('vm-juliet', [{ retirement: 'Gen1 images', retiresOn: '2027-01-01' }], { rg: 'rg-d', location: 'westeurope' })],
      T2: [vm('vm-ivy', [{ retirement: 'Basic tier', retiresOn: '2027-01-01' }], { sub: TEST_SUB_B, rg: 'rg-d', location: 'northeurope' }), vm('vm-juliet', [{ retirement: 'Gen1 images', retiresOn: '2027-01-01' }], { rg: 'rg-d', location: 'westeurope' })],
    },
  },
};
const LOGS_RULE = 'act-signin';
const LOGS_AT: Record<Moment, Record<string, unknown>[]> = {
  T0: [],
  T1: [{ UserId: 'alice', Result: 'fail', Detail: { ip: '10.0.0.1' }, Count: 5 }, { UserId: 'alice', Result: 'lock', Detail: { ip: '10.0.0.2' } }, { UserId: 'bob', Result: 'fail' }],
  T2: [{ UserId: 'alice', Result: 'fail', Detail: { ip: '10.0.0.1' }, Count: 7 }, { UserId: 'bob', Result: 'fail' }, { UserId: 'carol', Result: 'fail', Detail: { ip: '10.0.0.3' } }],
};

const kqlOf = (id: string) => `resources | where type == "microsoft.compute/virtualmachines" // ${id}`;
const baseRule = {
  description: 'test rule', enabled: true, scope: JSON.stringify({ level: 'subscription' }),
  resourceTypes: JSON.stringify([]), conditions: JSON.stringify([]), type: 'custom',
};

async function insertRules(): Promise<void> {
  for (const [id, plan] of Object.entries(ARG_RULES)) {
    await execRun(db.delete(rulesTable).where(eq(rulesTable.id, id)));
    await execRun(db.insert(rulesTable).values({
      ...baseRule, id, name: plan.name, category: plan.category, severity: plan.severity, kind: plan.kind,
      rawKql: kqlOf(id), tags: plan.tags ? JSON.stringify(plan.tags) : null, group: plan.group ?? null,
    }));
  }
  await execRun(db.delete(rulesTable).where(eq(rulesTable.id, LOGS_RULE)));
  await execRun(db.insert(rulesTable).values({
    ...baseRule, id: LOGS_RULE, name: 'Failed sign-ins', category: 'identity', severity: 'medium', kind: 'activity',
    queryBackend: 'log-analytics', logsQuery: JSON.stringify({ kql: 'SigninLogs | where ResultType != 0', timeWindowDays: 30, dimensionKeyField: 'UserId' }),
  }));
}

async function scanAt(moment: Moment): Promise<void> {
  const rowsFor = (kql: string) => {
    const id = Object.keys(ARG_RULES).find(rule => kql.endsWith(`// ${rule}`));
    return (id ? ARG_RULES[id]!.at[moment] ?? [] : []).flatMap(res => res.rows.map(extra => argRow({
      name: res.name, subscriptionId: res.sub ?? TEST_SUB_A, resourceGroup: res.rg ?? 'rg-a', location: res.location ?? 'westeurope', ...extra,
    })));
  };
  for (const categoryId of ['security', 'cost', 'reliability'] as const) {
    const ruleIds = Object.entries(ARG_RULES).filter(([, plan]) => plan.category === categoryId).map(([id]) => id);
    await runCategoryScan((await getCategory(categoryId))!, {
      ctx: fakeTenantContext({ rows: rowsFor, subscriptionIds: [TEST_SUB_A, TEST_SUB_B] }), ruleIds, now: new Date(AT[moment]),
    });
  }
  await runCategoryScan((await getCategory('identity'))!, {
    ctx: fakeTenantContext({ logsRows: () => LOGS_AT[moment] }), ruleIds: [LOGS_RULE], now: new Date(AT[moment]),
  });
}

const resourceId = (name: string, sub = TEST_SUB_A, rg = 'rg-a') => String(argRow({ name, subscriptionId: sub, resourceGroup: rg }).id);

beforeAll(async () => {
  await resetDb();
  await insertRules();
  await scanAt('T0');
  await scanAt('T1');
  await scanAt('T2');
  // vm-bravo's finding is suppressed for good; vm-golf's suppression ran out, so it is not.
  await addSuppression({ id: 'sup-bravo', fingerprint: computeFingerprint('sec-high', resourceId('vm-bravo', TEST_SUB_B, 'rg-b')), reason: 'Accepted', suppressedAt: new Date(AT.T1).toISOString() });
  await addSuppression({ id: 'sup-golf', fingerprint: computeFingerprint('cost-medium', resourceId('vm-golf', TEST_SUB_B, 'rg-c')), reason: 'Was accepted', suppressedAt: new Date(AT.T0).toISOString(), expiresAt: new Date(AT.T1).toISOString() });
  // A rule that is gone, and one that is disabled: their findings stay, named as the explorer names them.
  await execRun(db.delete(rulesTable).where(eq(rulesTable.id, 'cost-low')));
  await execRun(db.update(rulesTable).set({ enabled: false }).where(eq(rulesTable.id, 'cost-medium')));
});

afterEach(() => { mockRequireRole.mockReset(); });

// ---- The reference, over every finding ----

async function referenceView(view: View, tab: ViewTab, showSuppressed: boolean): Promise<ViewResponse> {
  const { findings, options, ctx } = await referenceInputs(tab, showSuppressed);
  return wire(buildViewResponse(findings, view, ctx, options));
}

async function getView(view: View, tab: ViewTab, showSuppressed: boolean): Promise<Response> {
  mockRequireRole.mockResolvedValue({ id: 'viewer' });
  const query = viewToSearchParams(view, { tab, ...(showSuppressed ? { suppressed: '1' } : {}) });
  return viewRoute.GET(new Request(`http://localhost/api/findings/view?${query}`));
}

// ---- The table of views ----

const make = (patch: Partial<View> & { filters?: ViewFilter[] }): View => ({ ...emptyView(), ...patch });
const f = (field: ViewFilter['field'], ...values: string[]): ViewFilter => ({ field, values } as ViewFilter);

interface Case { name: string; view: View; tab?: ViewTab }

const RESULTS_VIEWS: Case[] = [
  { name: 'the default view', view: make({}) },
  { name: 'a category', view: make({ filters: [f('category', 'security')] }) },
  { name: 'two rules', view: make({ filters: [f('rule', 'sec-high', 'cost-medium')] }) },
  { name: 'two severities', view: make({ filters: [f('severity', 'critical', 'high')] }) },
  { name: 'status Fixed', view: make({ filters: [f('status', 'fixed')] }) },
  { name: 'status New', view: make({ filters: [f('status', 'new')] }) },
  { name: 'status All', view: make({ filters: [f('status', 'all')] }) },
  { name: 'a subscription', view: make({ filters: [f('subscription', TEST_SUB_B)] }) },
  { name: 'a resource group', view: make({ filters: [f('resourceGroup', 'rg-a')] }) },
  { name: 'a location', view: make({ filters: [f('location', 'northeurope')] }) },
  { name: 'a rule tag', view: make({ filters: [f('tags', 'finops')] }) },
  { name: 'the Activity kind', view: make({ filters: [f('kind', 'activity')] }) },
  { name: 'a resource type', view: make({ filters: [f('resourceType', 'microsoft.compute/virtualmachines')] }) },
  { name: 'a resource name', view: make({ filters: [f('resourceName', 'vm-alpha')] }) },
  { name: 'the first-seen day of the oldest scan', view: make({ filters: [f('firstSeen', dayKey('T0'))] }) },
  { name: 'the last-seen day of the newest scan', view: make({ filters: [f('lastSeen', dayKey('T2'))] }) },
  { name: 'several built-in filters at once', view: make({ filters: [f('severity', 'high', 'low'), f('category', 'security', 'cost'), f('location', 'westeurope')] }) },
  { name: 'a returned column', view: make({ filters: [f('row.properties.sku.name', 'S1')] }) },
  { name: 'two returned columns', view: make({ filters: [f('row.properties.sku.name', 'S1'), f('row.zone', '1')] }) },
  { name: 'a returned column on its blank value', view: make({ filters: [f('row.zone', '')] }) },
  { name: 'a returned column holding a URL, a number and a boolean', view: make({ filters: [f('row.link', 'https://docs.example/basic'), f('row.count', '3')] }) },
  { name: 'a returned column holding a boolean', view: make({ filters: [f('row.flag', 'true')] }) },
  { name: 'a returned column holding an array', view: make({ filters: [f('row.list', '[1,2]')] }) },
  { name: 'a returned column holding an object', view: make({ filters: [f('row.properties.sku', '{"name":"S1"}')] }) },
  { name: 'a returned column no finding has', view: make({ filters: [f('row.nope', 'x')] }) },
  { name: 'a returned column and a built-in filter', view: make({ filters: [f('severity', 'high'), f('row.properties.sku.name', 'S2')] }) },
  // The facets and tiles count findings with a filter of their own lifted, so these read rows of
  // findings the view itself does not list.
  { name: 'a returned column and a category filter', view: make({ filters: [f('category', 'security'), f('row.properties.sku.name', 'S1')] }) },
  { name: 'a returned column and two filters that the tiles lift together', view: make({ filters: [f('severity', 'high'), f('resourceName', 'VM-ECHO'), f('row.zone', '1')] }) },
  { name: 'a returned column and a status filter', view: make({ filters: [f('status', 'fixed'), f('row.zone', '3')] }) },
  { name: 'search by resource name, ignoring case', view: make({ search: 'ALPHA' }) },
  { name: 'search by rule name', view: make({ search: 'premium' }) },
  { name: 'search by resource type', view: make({ search: 'virtualmachines' }) },
  { name: 'search by resource id', view: make({ search: 'resourcegroups/rg-b' }) },
  { name: 'search that matches nothing', view: make({ search: 'zzz-no-such' }) },
  { name: 'search with a returned column', view: make({ search: 'alpha', filters: [f('row.zone', '2')] }) },
  { name: 'a custom window with status New', view: make({ filters: [f('status', 'new')], window: { mode: 'custom', from: dayKey('T0'), to: dayKey('T1') } }) },
  { name: 'a one-day window with status New', view: make({ filters: [f('status', 'new')], window: { mode: 'relative', days: 1 } }) },
  { name: 'a long window with status Fixed', view: make({ filters: [f('status', 'fixed')], window: { mode: 'relative', days: 365 } }) },
  { name: 'sort by rule', view: make({ sort: { field: 'rule', dir: 'asc' } }) },
  { name: 'sort by severity, descending', view: make({ sort: { field: 'severity', dir: 'desc' } }) },
  { name: 'sort by resource, descending', view: make({ sort: { field: 'resourceName', dir: 'desc' } }) },
  { name: 'sort by last seen', view: make({ sort: { field: 'lastSeen', dir: 'asc' } }) },
  { name: 'sort by first seen, descending', view: make({ sort: { field: 'firstSeen', dir: 'desc' } }) },
  { name: 'sort by tags', view: make({ sort: { field: 'tags', dir: 'asc' } }) },
  { name: 'sort by a returned column, empty values last', view: make({ sort: { field: 'row.properties.sku.name', dir: 'asc' } }) },
  { name: 'sort by a returned column, descending, empty values last', view: make({ sort: { field: 'row.zone', dir: 'desc' } }) },
  // Findings that tie on the sorted value fall to the fingerprint, whichever way the sort runs.
  { name: 'sort by category, where most findings tie', view: make({ sort: { field: 'category', dir: 'asc' } }) },
  { name: 'sort by category, descending', view: make({ sort: { field: 'category', dir: 'desc' } }) },
  { name: 'sort by subscription, where most findings tie', view: make({ sort: { field: 'subscription', dir: 'desc' } }) },
  { name: 'sort by kind', view: make({ sort: { field: 'kind', dir: 'asc' } }) },
  { name: 'sort by status, with every status listed', view: make({ filters: [f('status', 'all')], sort: { field: 'status', dir: 'asc' } }) },
  { name: 'sort by resource group, where some findings have none', view: make({ sort: { field: 'resourceGroup', dir: 'desc' } }) },
  // VM-ECHO has no resource group and no location: an empty value sorts last, either way. The Activity findings,
  // which have neither and no type either, are on their own tab.
  { name: 'sort by location, empty values last', view: make({ sort: { field: 'location', dir: 'asc' } }) },
  { name: 'sort by location, descending, empty values still last', view: make({ sort: { field: 'location', dir: 'desc' } }) },
  { name: 'sort by resource type, descending', view: make({ sort: { field: 'resourceType', dir: 'desc' } }) },
  { name: 'sort by a returned number', view: make({ sort: { field: 'row.item', dir: 'asc' } }) },
  { name: 'sort by a returned number, descending', view: make({ sort: { field: 'row.count', dir: 'desc' } }) },
  { name: 'sort by a returned column that most findings lack', view: make({ sort: { field: 'row.link', dir: 'asc' } }) },
  { name: 'sort by a returned column after filtering its rows', view: make({ filters: [f('row.properties.sku.name', 'S1')], sort: { field: 'row.item', dir: 'desc' } }) },
  { name: 'search in capitals', view: make({ search: 'BASIC TIER' }) },
  { name: 'search with mixed case on a resource name that has capitals', view: make({ search: 'vM-eChO' }) },
  { name: 'search for a literal percent sign', view: make({ search: '%' }) },
  { name: 'search for a literal underscore', view: make({ search: '_' }) },
  { name: 'search for a single quote', view: make({ search: '\'' }) },
  // vm-golf's suppression ran out, so it is listed; vm-bravo's has no end, so it is not.
  { name: 'the finding whose suppression ran out', view: make({ filters: [f('resourceName', 'vm-golf')] }) },
  { name: 'the finding whose suppression has no end', view: make({ filters: [f('resourceName', 'vm-bravo')] }) },
  // Window edges: a custom window takes whole days, ends included.
  { name: 'a window of the one day the oldest scan ran, New', view: make({ filters: [f('status', 'new')], window: { mode: 'custom', from: dayKey('T0'), to: dayKey('T0') } }) },
  { name: 'a window of the one day the middle scan ran, New', view: make({ filters: [f('status', 'new')], window: { mode: 'custom', from: dayKey('T1'), to: dayKey('T1') } }) },
  { name: 'a window of the one day the newest scan ran, New', view: make({ filters: [f('status', 'new')], window: { mode: 'custom', from: dayKey('T2'), to: dayKey('T2') } }) },
  { name: 'a window of only the day of the oldest scan, Fixed', view: make({ filters: [f('status', 'fixed')], window: { mode: 'custom', from: dayKey('T0'), to: dayKey('T0') } }) },
  { name: 'a window from the day of the middle scan to the newest, Fixed', view: make({ filters: [f('status', 'fixed')], window: { mode: 'custom', from: dayKey('T1'), to: dayKey('T2') } }) },
  { name: 'a window that holds no scan', view: make({ filters: [f('status', 'new')], window: { mode: 'custom', from: '2001-01-01', to: '2001-01-02' } }) },
  { name: 'picked columns, one that nothing has', view: make({ columns: ['zone', 'properties.sku.name', 'nothing.here'] }) },
  { name: 'the second page', view: make({ page: 2 }) },
  { name: 'a page past the end', view: make({ page: 99 }) },
  { name: 'grouped by category', view: make({ groupBy: ['category'] }) },
  { name: 'grouped by rule then severity', view: make({ groupBy: ['rule', 'severity'] }) },
  { name: 'grouped by a returned column', view: make({ groupBy: ['row.properties.sku.name'] }) },
  { name: 'grouped by category then a returned column', view: make({ groupBy: ['category', 'row.zone'] }) },
  { name: 'grouped by rule tag, a finding under each tag', view: make({ groupBy: ['tags'] }) },
  { name: 'grouped by subscription', view: make({ groupBy: ['subscription'] }) },
  { name: 'grouped by kind', view: make({ groupBy: ['kind'] }) },
  { name: 'grouped by two days', view: make({ groupBy: ['firstSeen', 'lastSeen'] }) },
  { name: 'groups by count, most first', view: make({ groupBy: ['category'], groupSort: { by: 'count', dir: 'desc' } }) },
  { name: 'groups by value, descending', view: make({ groupBy: ['rule'], groupSort: { by: 'value', dir: 'desc' } }) },
  { name: 'grouped with a returned column filter', view: make({ groupBy: ['row.properties.sku.name'], filters: [f('row.properties.sku.name', 'S1')] }) },
  { name: 'grouped by resource, the second page of groups', view: make({ groupBy: ['resourceName'], page: 2 }) },
  { name: 'grouped by category, items sorted by resource with ties', view: make({ groupBy: ['category'], sort: { field: 'subscription', dir: 'asc' } }) },
  { name: 'grouped by location, the empty value last', view: make({ groupBy: ['location'], groupSort: { by: 'value', dir: 'desc' } }) },
  { name: 'grouped by resource type, groups by count', view: make({ groupBy: ['resourceType'], groupSort: { by: 'count', dir: 'asc' } }) },
  { name: 'grouped and sorted by a returned column', view: make({ groupBy: ['category'], sort: { field: 'row.zone', dir: 'asc' } }) },
];

const ADVISORY_VIEWS = [
  { name: 'the default view', view: make({}) },
  { name: 'status All', view: make({ filters: [f('status', 'all')] }) },
  { name: 'a returned column', view: make({ filters: [f('row.retirement', 'Basic tier')] }) },
  { name: 'grouped by a returned column', view: make({ groupBy: ['row.retirement'] }) },
  { name: 'search', view: make({ search: 'ivy' }) },
].map(c => ({ ...c, tab: 'advisories' as const }));

const ACTIVITY_VIEWS = [
  { name: 'the default view', view: make({}) },
  { name: 'status New', view: make({ filters: [f('status', 'new')] }) },
  { name: 'status All', view: make({ filters: [f('status', 'all')] }) },
  { name: 'a severity', view: make({ filters: [f('severity', 'medium')] }) },
  { name: 'a category', view: make({ filters: [f('category', 'identity')] }) },
  { name: 'a returned column', view: make({ filters: [f('row.Result', 'lock')] }) },
  { name: 'search by pattern', view: make({ search: 'CAROL' }) },
  { name: 'sort by last seen, descending', view: make({ sort: { field: 'lastSeen', dir: 'desc' } }) },
  { name: 'grouped by rule', view: make({ groupBy: ['rule'] }) },
].map(c => ({ ...c, tab: 'activity' as const }));

const VIEW_CASES = [...RESULTS_VIEWS.map(c => ({ ...c, tab: 'results' as const })), ...ADVISORY_VIEWS, ...ACTIVITY_VIEWS];

describe('GET /api/findings/view answers what the explorer computes over every finding', () => {
  it.each(VIEW_CASES)('$tab: $name', async ({ view, tab }) => {
    const res = await getView(view, tab, false);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(await referenceView(view, tab, false));
  });

  it.each([
    ['the default view', make({})],
    ['status All', make({ filters: [f('status', 'all')] })],
    ['a category', make({ filters: [f('category', 'security')] })],
    ['grouped by rule', make({ groupBy: ['rule'] })],
    ['a returned column', make({ filters: [f('row.zone', '')] })],
  ] as const)('with suppressed findings shown: %s', async (_name, view) => {
    const res = await getView(view, 'results', true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(await referenceView(view, 'results', true));
  });
});

describe('what the fixture holds, so the reference itself is pinned', () => {
  it('lists the open findings of every rule on the Results tab, one page of 50, and hides the suppressed one', async () => {
    const body = await (await getView(make({}), 'results', false)).json() as ViewResponse;
    // sec-high 2 (alpha, delta) + sec-critical 2 + cost-medium 2 + cost-low 1 + 60 bulk; bravo is suppressed.
    // The 3 sign-ins are Activity findings, listed on their own tab.
    expect(body.total).toBe(67);
    expect([body.page, body.pageCount, body.items.length]).toEqual([1, 2, 50]);
    expect(body.suppressedCount).toBe(1);
    expect(body.kinds).toEqual(['state']);
  });

  it('shows the suppressed finding when asked', async () => {
    const body = await (await getView(make({}), 'results', true)).json() as ViewResponse;
    expect(body.total).toBe(68);
  });

  it('lists the one Fixed finding under status Fixed, and every finding under All', async () => {
    const fixed = await (await getView(make({ filters: [f('status', 'fixed')] }), 'results', false)).json() as ViewResponse;
    expect(fixed.items.map(i => i.finding.resourceName)).toEqual(['vm-charlie']);
    const all = await (await getView(make({ filters: [f('status', 'all')] }), 'results', false)).json() as ViewResponse;
    expect(all.total).toBe(68);
  });

  it('lists the three Activity findings on the Activity tab, by pattern, and none on Results', async () => {
    const body = await (await getView(make({}), 'activity', false)).json() as ViewResponse;
    expect(body.total).toBe(3);
    expect(body.kinds).toEqual(['activity']);
    expect(body.items.map(i => i.finding.dimensionKey).sort()).toEqual(['alice', 'bob', 'carol']);
    const onResults = await (await getView(make({ filters: [f('rule', LOGS_RULE), f('status', 'all')] }), 'results', true)).json() as ViewResponse;
    expect(onResults.total).toBe(0);
  });

  it('counts the Activity findings in the Activity tab tiles, and in none of the Results tiles', async () => {
    const activity = await (await getView(make({}), 'activity', false)).json() as ViewResponse;
    expect(activity.tiles.total).toBe(3);
    expect(activity.tiles.counts.medium).toBe(3);
    const results = await (await getView(make({}), 'results', false)).json() as ViewResponse;
    expect(results.tiles.total).toBe(results.total);
  });

  it('lists the four Advisory findings on the Advisories tab, and none on Results', async () => {
    const body = await (await getView(make({}), 'advisories', false)).json() as ViewResponse;
    expect(body.total).toBe(4);
    expect(body.kinds).toEqual(['advisory']);
    expect(body.items.map(i => i.finding.policyName).sort()).toEqual(['SKU changes', 'SKU changes', 'Service retirements', 'Service retirements']);
  });

  it('sends a finding with its first 20 rows only, and counts the rest', async () => {
    const body = await (await getView(make({ filters: [f('resourceName', 'vm-delta')] }), 'results', false)).json() as ViewResponse;
    const item = body.items[0]!;
    expect([item.rows.length, item.rowCount, item.matchedRowCount]).toEqual([20, 25, 25]);
    expect(item.rows[0]).toEqual({ item: 0, properties: { sku: { name: 'S2' } } });
    expect(item.finding).not.toHaveProperty('rows');
  });

  it('keeps only the rows that match a returned-column filter, and counts both', async () => {
    const body = await (await getView(make({ filters: [f('resourceName', 'vm-delta'), f('row.properties.sku.name', 'S1')] }), 'results', false)).json() as ViewResponse;
    const item = body.items[0]!;
    expect([item.rows.length, item.rowCount, item.matchedRowCount]).toEqual([12, 25, 12]);
  });

  it('names a finding whose rule is gone by its title, and one whose rule is disabled as disabled', async () => {
    const gone = await (await getView(make({ filters: [f('resourceName', 'vm-hotel')] }), 'results', false)).json() as ViewResponse;
    expect(gone.items[0]!.finding).toMatchObject({ policyName: gone.items[0]!.finding.title, ruleTags: [] });
    const disabled = await (await getView(make({ filters: [f('resourceName', 'vm-fox')] }), 'results', false)).json() as ViewResponse;
    expect(disabled.items[0]!.finding).toMatchObject({ policyName: 'Premium disks', ruleDisabled: true, ruleTags: ['finops', 'prod'] });
  });

  it('lists the columns of the Results tab as exactly the ones its findings\' rows hold, Fixed and rule-less findings included', async () => {
    // sec-high: count, empty, item, link, properties.sku.name, properties.tier, retirement, zone. sec-critical:
    // list, flag, nul, zone and nested.deep.deeper (three levels are walked, the fourth is one column).
    // cost-medium, cost-low and cost-bulk: sku, savings, batch, properties.sku.name. The sign-ins' columns are
    // the Activity tab's.
    const body = await (await getView(make({}), 'results', false)).json() as ViewResponse;
    expect(body.columns).toEqual([
      'batch', 'count', 'empty', 'flag', 'item', 'link', 'list', 'nested.deep.deeper', 'nul',
      'properties.sku.name', 'properties.tier', 'retirement', 'savings', 'sku', 'zone',
    ]);
  });

  it('still offers a Logs rule in the dashboard filter lists, though its findings are on the Activity tab', async () => {
    const { rules } = await queryFilterOptions();
    expect(rules.map(r => r.id)).toContain(LOGS_RULE);
  });

  it('lists the columns of the Activity tab as exactly the ones the sign-in rows hold', async () => {
    // The sorted order puts a lower-case name before its capitalised twin, so Count sorts with the c's.
    const body = await (await getView(make({}), 'activity', false)).json() as ViewResponse;
    expect(body.columns).toEqual(['Count', 'Detail.ip', 'Result', 'UserId']);
  });

  it('lists the columns of the Advisories tab as exactly the ones its two rules\' rows hold', async () => {
    const body = await (await getView(make({}), 'advisories', false)).json() as ViewResponse;
    expect(body.columns).toEqual(['retirement', 'retiresOn']);
  });

  it('offers the columns the rules in play have returned', async () => {
    const body = await (await getView(make({ filters: [f('rule', 'sec-high')] }), 'results', false)).json() as ViewResponse;
    expect(body.columns).toEqual(expect.arrayContaining(['properties.sku.name', 'zone', 'link', 'count', 'item']));
    expect(body.columns).toEqual([...body.columns].sort((a, b) => a.localeCompare(b)));
  });
});

// ---- The three secondary routes ----

type RouteHandler = { GET(req: Request): Promise<Response> };

async function getFrom(route: RouteHandler, name: string, view: View, params: Record<string, string>): Promise<Response> {
  mockRequireRole.mockResolvedValue({ id: 'viewer' });
  const query = viewToSearchParams(view, params);
  return route.GET(new Request(`http://localhost/api/findings/${name}?${query}`));
}

const fingerprintOf = async (ruleId: string, resourceName: string) =>
  (await listFindings()).find(r => r.ruleId === ruleId && r.resourceName === resourceName)!.fingerprint;

describe('GET /api/findings/rows answers one finding\'s rows as the explorer pages them', () => {
  interface RowsCase { name: string; view?: View; tab?: ViewTab; rule: string; resource: string; rowsPage?: number; found?: boolean }
  const ROWS_CASES: RowsCase[] = [
    { name: 'the first page of a finding with 25 rows', rule: 'sec-high', resource: 'vm-delta' },
    { name: 'the second page', rule: 'sec-high', resource: 'vm-delta', rowsPage: 2 },
    { name: 'a page past the end', rule: 'sec-high', resource: 'vm-delta', rowsPage: 9 },
    { name: 'only the rows that match a returned-column filter', rule: 'sec-high', resource: 'vm-delta', view: make({ filters: [f('row.properties.sku.name', 'S1')] }) },
    { name: 'a returned-column filter nothing matches', rule: 'sec-high', resource: 'vm-delta', view: make({ filters: [f('row.properties.sku.name', 'S9')] }) },
    { name: 'a finding that holds one empty row', rule: 'sec-high', resource: 'vm-bravo' },
    { name: 'a finding with nested values', rule: 'sec-critical', resource: 'VM-ECHO' },
    { name: 'the built-in filters, which do not apply to a finding asked for by name', rule: 'sec-high', resource: 'vm-alpha', view: make({ filters: [f('severity', 'low'), f('status', 'fixed')] }) },
    { name: 'a Fixed finding', rule: 'sec-high', resource: 'vm-charlie' },
    { name: 'an Activity finding on the Activity tab, by its dimension key', tab: 'activity', rule: LOGS_RULE, resource: 'alice' },
    { name: 'an Activity finding on the Results tab, which does not list it', rule: LOGS_RULE, resource: 'alice', found: false },
    { name: 'an Advisory finding on the Advisories tab', tab: 'advisories', rule: 'adv-retire', resource: 'vm-alpha' },
    { name: 'an Advisory finding on the Results tab, which does not list it', rule: 'adv-retire', resource: 'vm-alpha', found: false },
  ];

  it.each(ROWS_CASES)('$name', async ({ view = make({}), tab = 'results', rule, resource, rowsPage, found = true }) => {
    const fingerprint = (await listFindings()).find(r => r.ruleId === rule && (r.resourceName === resource || r.dimensionKey === resource))!.fingerprint;
    const res = await getFrom(rowsRoute, 'rows', view, { tab, fingerprint, ...(rowsPage ? { rowsPage: String(rowsPage) } : {}) });
    const { findings, options, ctx } = await referenceInputs(tab, false);
    const expected = buildFindingRowsResponse(findings, view, ctx, { tab, fingerprint, rowsPage: rowsPage ?? 1 });
    if (!found) {
      expect(expected).toBeNull();
      expect(res.status).toBe(404);
      return;
    }
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(wire(expected));
    void options;
  });

  it('pages the 25 rows of a finding 20 and 5, in position order, with where the page starts', async () => {
    const fingerprint = await fingerprintOf('sec-high', 'vm-delta');
    const second = await (await getFrom(rowsRoute, 'rows', make({}), { tab: 'results', fingerprint, rowsPage: '2' })).json() as FindingRowsResponse;
    expect([second.rows.length, second.page, second.pageCount, second.rowCount, second.matchedRowCount, second.firstIndex]).toEqual([5, 2, 2, 25, 25, 20]);
    expect(second.rows[0]).toEqual({ item: 20, properties: { sku: { name: 'S2' } } });
  });

  it('answers 404 for a fingerprint no finding has', async () => {
    const res = await getFrom(rowsRoute, 'rows', make({}), { tab: 'results', fingerprint: 'no-such-fingerprint' });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/findings/group answers one group as the explorer opens it', () => {
  interface GroupCase { name: string; view: View; path: (string | null)[]; page?: number; tab?: ViewTab; suppressed?: boolean; empty?: boolean }
  const GROUP_CASES: GroupCase[] = [
    { name: 'a top-level group of a single level, its findings', view: make({ groupBy: ['category'] }), path: ['security'] },
    { name: 'a group with more than a page of findings, page 1', view: make({ groupBy: ['category'] }), path: ['cost'] },
    { name: 'the same group, page 2', view: make({ groupBy: ['category'] }), path: ['cost'], page: 2 },
    { name: 'the same group, a page past the end', view: make({ groupBy: ['category'] }), path: ['cost'], page: 9 },
    { name: 'a group above the last level, the next level\'s headers', view: make({ groupBy: ['rule', 'severity'] }), path: ['sec-high'] },
    { name: 'the last level of two', view: make({ groupBy: ['rule', 'severity'] }), path: ['sec-high', 'high'] },
    { name: 'a group by a returned column', view: make({ groupBy: ['row.properties.sku.name'] }), path: ['S1'] },
    { name: 'the empty-value group of a returned column', view: make({ groupBy: ['row.zone'] }), path: [null] },
    { name: 'a returned column below a built-in', view: make({ groupBy: ['category', 'row.zone'] }), path: ['security', '1'] },
    { name: 'a returned column below a built-in, its empty-value group', view: make({ groupBy: ['category', 'row.zone'] }), path: ['security', null] },
    { name: 'a group by rule tag', view: make({ groupBy: ['tags'] }), path: ['finops'] },
    { name: 'a group by resource', view: make({ groupBy: ['resourceName'] }), path: ['vm-alpha'] },
    { name: 'groups ordered by count', view: make({ groupBy: ['rule', 'location'], groupSort: { by: 'count', dir: 'desc' } }), path: ['sec-high'] },
    { name: 'groups ordered by value, descending', view: make({ groupBy: ['rule', 'location'], groupSort: { by: 'value', dir: 'desc' } }), path: ['sec-high'] },
    { name: 'a returned-column filter, which also decides the rows each finding holds', view: make({ groupBy: ['category'], filters: [f('row.properties.sku.name', 'S1')] }), path: ['security'] },
    { name: 'a sort by a returned column', view: make({ groupBy: ['category'], sort: { field: 'row.zone', dir: 'desc' } }), path: ['security'] },
    { name: 'with suppressed findings shown', view: make({ groupBy: ['rule'] }), path: ['sec-high'], suppressed: true },
    { name: 'on the Advisories tab', view: make({ groupBy: ['row.retirement'] }), path: ['Basic tier'], tab: 'advisories' },
    { name: 'on the Activity tab', view: make({ groupBy: ['rule'] }), path: [LOGS_RULE], tab: 'activity' },
    { name: 'a path that leads to no group', view: make({ groupBy: ['category'] }), path: ['no-such-category'], empty: true },
    { name: 'a path longer than the grouping', view: make({ groupBy: ['category'] }), path: ['security', 'high'], empty: true },
    { name: 'an empty path', view: make({ groupBy: ['category'] }), path: [], empty: true },
    { name: 'a view with no grouping', view: make({}), path: ['security'], empty: true },
  ];

  it.each(GROUP_CASES)('$name', async ({ view, path, page, tab = 'results', suppressed = false, empty = false }) => {
    const res = await getFrom(groupRoute, 'group', view, { tab, groupPath: JSON.stringify(path), ...(page ? { groupPage: String(page) } : {}), ...(suppressed ? { suppressed: '1' } : {}) });
    expect(res.status).toBe(200);
    const body = await res.json() as GroupResponse;
    const { findings, options, ctx } = await referenceInputs(tab, suppressed);
    expect(body).toEqual(wire(buildGroupResponse(findings, view, ctx, { ...options, groupPath: path, groupPage: page ?? 1 })));
    // The table does not pass by both sides being empty.
    expect(body.group === null).toBe(empty);
  });

  it('opens a group of 63 findings 50 and 13 at a time, each with its first rows', async () => {
    const first = await (await getFrom(groupRoute, 'group', make({ groupBy: ['category'] }), { tab: 'results', groupPath: '["cost"]' })).json() as GroupResponse;
    expect([first.group?.resourceCount, first.total, first.pageCount, first.items.length]).toEqual([63, 63, 2, 50]);
    const second = await (await getFrom(groupRoute, 'group', make({ groupBy: ['category'] }), { tab: 'results', groupPath: '["cost"]', groupPage: '2' })).json() as GroupResponse;
    expect(second.items.length).toBe(13);
    expect(first.items[0]!.rows.length).toBeGreaterThan(0);
  });
});

describe('GET /api/findings/column-values answers a returned column\'s values as the explorer lists them', () => {
  interface ValuesCase { name: string; view?: View; column: string; q?: string; tab?: ViewTab; suppressed?: boolean; empty?: boolean }
  const VALUES_CASES: ValuesCase[] = [
    { name: 'a nested column', column: 'row.properties.sku.name' },
    { name: 'a column with blank values', column: 'row.zone' },
    { name: 'a column of numbers', column: 'row.item' },
    { name: 'a column of booleans and nulls', column: 'row.flag' },
    { name: 'a column holding arrays', column: 'row.list' },
    { name: 'a column holding objects', column: 'row.properties.sku' },
    { name: 'a column no finding has', column: 'row.nope', empty: true },
    { name: 'a search, ignoring case', column: 'row.properties.sku.name', q: 's1' },
    { name: 'a search nothing matches', column: 'row.properties.sku.name', q: 'zzz', empty: true },
    { name: 'a built-in filter', column: 'row.properties.sku.name', view: make({ filters: [f('category', 'security')] }) },
    { name: 'a filter on this same column, which does not hide the other values', column: 'row.properties.sku.name', view: make({ filters: [f('row.properties.sku.name', 'S1')] }) },
    { name: 'a filter on another column, which narrows the rows', column: 'row.properties.sku.name', view: make({ filters: [f('row.zone', '2')] }) },
    { name: 'a search in the view', column: 'row.zone', view: make({ search: 'alpha' }) },
    { name: 'a search in the view and another in the column', column: 'row.zone', view: make({ search: 'alpha' }), q: '2' },
    { name: 'a status filter', column: 'row.zone', view: make({ filters: [f('status', 'fixed')] }) },
    { name: 'a status of All', column: 'row.zone', view: make({ filters: [f('status', 'all')] }) },
    { name: 'with suppressed findings shown', column: 'row.zone', suppressed: true },
    { name: 'the Advisories tab', column: 'row.retirement', tab: 'advisories' },
    { name: 'the Activity tab', column: 'row.Result', tab: 'activity' },
    { name: 'a column of the Activity findings, on the Results tab', column: 'row.Result', empty: true },
  ];

  it.each(VALUES_CASES)('$name', async ({ view = make({}), column, q, tab = 'results', suppressed = false, empty = false }) => {
    const res = await getFrom(columnValuesRoute, 'column-values', view, { tab, column, ...(q !== undefined ? { valueQuery: q } : {}), ...(suppressed ? { suppressed: '1' } : {}) });
    expect(res.status).toBe(200);
    const body = await res.json() as ColumnValuesResponse;
    const { findings, ctx } = await referenceInputs(tab, suppressed);
    expect(body).toEqual(wire(buildColumnValuesResponse(findings, view, ctx, { tab, column: column as `row.${string}`, q })));
    expect(body.values.length === 0).toBe(empty);
  });

  it('lists the values of a nested column most findings first, with how many findings hold each', async () => {
    const body = await (await getFrom(columnValuesRoute, 'column-values', make({ filters: [f('rule', 'sec-high')] }), { tab: 'results', column: 'row.properties.sku.name' })).json() as ColumnValuesResponse;
    expect(body.values).toEqual([{ value: 'S1', count: 2 }, { value: 'S2', count: 2 }]);
    expect(body.total).toBe(2);
  });
});
