/**
 * The data behind the "As seen by" stamp (#338): the person, their Access as counts, the filters they hold
 * and the window the numbers were read over. It is built in the response that carries the dashboard, from the
 * same per-request Access, so the stamp and the numbers cannot disagree about who is looking.
 *
 * A value the person's Access does not reach is counted, never named: the marks come from
 * `markOutsideAccess`, the one definition of "outside your access". The Role is never part of it.
 */
import { holdsNoScope, type Access, type ScopeKind } from './access-model';
import { dateWindowLabelWithYear, resolveDateWindow, type DateWindow } from './date-window';
import { isOutsideAccess, markOutsideAccess } from './outside-access';
import type { WidgetFilters } from './dashboard-filters';
import { SEVERITY_LABEL } from '@/components/dashboard/dashboard-constants';
import type { AsSeenByStamp, DashboardConfig, Severity, StampAccessKind, StampFilterDimension } from './types';

const ACCESS_ORDER: { kind: StampAccessKind; scopeKind: ScopeKind; one: string; many: string }[] = [
  { kind: 'directory', scopeKind: 'directory', one: 'Directory', many: 'Directory' },
  { kind: 'managementGroup', scopeKind: 'managementGroup', one: 'management group', many: 'management groups' },
  { kind: 'subscription', scopeKind: 'subscription', one: 'subscription', many: 'subscriptions' },
  { kind: 'resourceGroup', scopeKind: 'resourceGroup', one: 'resource group', many: 'resource groups' },
];

function describeStampAccess(access: Access): AsSeenByStamp['access'] {
  if (access.everything) return { everything: true, counts: [], label: 'Everything' };
  if (holdsNoScope(access)) return { everything: false, counts: [], label: 'No access' };
  const held = new Set(access.grants.map(g => `${g.scope.kind}:${g.scope.path.toLowerCase()}`));
  const counts: AsSeenByStamp['access']['counts'] = [];
  const words: string[] = [];
  for (const { kind, scopeKind, one, many } of ACCESS_ORDER) {
    const count = [...held].filter(key => key.startsWith(`${scopeKind}:`)).length;
    if (count === 0) continue;
    counts.push({ kind, count });
    words.push(`${count} ${count === 1 ? one : many}`);
  }
  return { everything: false, counts, label: words.join(', ') };
}

export interface StampInput {
  person: { name: string | null; email: string };
  access: Access;
  filters: WidgetFilters;
  /** Category label by id and rule name by id: resolved by the caller from the database. */
  categoryLabels: Record<string, string>;
  ruleNames: Record<string, string>;
  now?: Date;
}

export function buildAsSeenByStamp({ person, access, filters, categoryLabels, ruleNames, now = new Date() }: StampInput): AsSeenByStamp {
  const marks = markOutsideAccess(access, { subscriptions: filters.subscriptions, resourceGroups: filters.resourceGroups });
  const dimensions: { dimension: StampFilterDimension; values: readonly string[] | undefined; name: (value: string) => string }[] = [
    { dimension: 'category', values: filters.categories, name: v => categoryLabels[v] ?? v },
    { dimension: 'rule', values: filters.ruleIds, name: v => ruleNames[v] ?? v },
    { dimension: 'subscription', values: filters.subscriptions, name: v => v },
    { dimension: 'resourceGroup', values: filters.resourceGroups, name: v => v },
    { dimension: 'tag', values: filters.tags, name: v => v },
    { dimension: 'severity', values: filters.severities, name: v => SEVERITY_LABEL[v as Severity] ?? v },
  ];

  const shown: AsSeenByStamp['filters'] = [];
  for (const { dimension, values, name } of dimensions) {
    if (!values?.length) continue;
    const marked = dimension === 'subscription' ? marks.subscriptions : dimension === 'resourceGroup' ? marks.resourceGroups : [];
    const held = values.filter(v => !(dimension === 'subscription' || dimension === 'resourceGroup')
      || !isOutsideAccess(marks, dimension, v));
    shown.push({ dimension, values: held.map(name), heldBack: marked.length });
  }

  const { from, to } = resolveDateWindow(filters.dateWindow, now);
  return {
    person: person.name?.trim() || person.email,
    access: describeStampAccess(access),
    filters: shown,
    dateWindow: { label: dateWindowLabelWithYear(filters.dateWindow, now), from, to },
  };
}

/** Whether `key` is a real calendar day (`2026-02-30` has the right shape and is not one). */
function isCalendarDay(key: string | null): key is string {
  if (key === null || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const day = new Date(`${key}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === key;
}

/**
 * The filters the page is showing: the dashboard's saved filter bar, then what the page's address changes.
 * The client sends only the differences, named as `buildSummaryParams` names them. A dimension present in the
 * address replaces the saved one whole (an empty one clears it), and the rest stay as saved. A window the
 * address gives that cannot be read leaves the saved window alone.
 */
export function effectiveStampFilters(config: DashboardConfig, url: URLSearchParams): WidgetFilters {
  const saved = config.filters ?? {};
  const effective: WidgetFilters = {
    categories: saved.categories,
    subscriptions: saved.subscriptions,
    resourceGroups: saved.resourceGroups,
    tags: saved.tags,
    severities: saved.severities,
    ruleIds: saved.ruleIds,
    dateWindow: config.dateWindow ?? { mode: 'relative', days: config.windowDays ?? 7 },
  };

  const list = (param: string): string[] | undefined => {
    const values = (url.get(param) ?? '').split(',').map(s => s.trim()).filter(Boolean);
    return values.length > 0 ? values : undefined;
  };
  if (url.has('categories')) effective.categories = list('categories');
  if (url.has('subscriptions')) effective.subscriptions = list('subscriptions');
  if (url.has('resourceGroups')) effective.resourceGroups = list('resourceGroups');
  if (url.has('tags')) effective.tags = list('tags');
  if (url.has('severities')) effective.severities = list('severities') as Severity[] | undefined;
  if (url.has('ruleIds')) effective.ruleIds = list('ruleIds');

  const from = url.get('from');
  const to = url.get('to');
  const days = Number.parseInt(url.get('window') ?? '', 10);
  let dateWindow: DateWindow | null = null;
  if (isCalendarDay(from) && isCalendarDay(to)) dateWindow = { mode: 'custom', from, to };
  else if (Number.isFinite(days) && days > 0) dateWindow = { mode: 'relative', days };
  if (dateWindow) effective.dateWindow = dateWindow;
  return effective;
}
