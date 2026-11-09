import { DIRECTORY_SCOPE_PATH, parseScope } from '../access-model';
import { MAX_SAVED_VIEW_QUERY_LENGTH } from '../saved-view-query';
import { SCOPE_INLINE_BUDGET, esc, filterValues, viewFromSearchParams, withoutLegacyScope } from '../finding-view';
import { DIRECTORY_SUBSCRIPTION } from '../placement';
import { unresolvedPick } from '../unresolved-pick';
import { distinctPaths, scopeSetHash } from '../scope-sets';
import { migrateDashboardConfig } from '../dashboard-migrations';
import type { DashboardConfig, DashboardDimensionFilters, LegacyDashboardFilters, LegacyWidgetValues, WidgetDef } from '../types';

/**
 * Converts the filters that dashboards and saved views stored as two lists, subscriptions and resource group
 * names, into Scope picks (ADR 0015). Written beside the legacy values and never over them, so 0.13 still
 * reads what it stored after a rollback.
 *
 * - A subscription id is `/subscriptions/{id}` and `directory` is `@directory`.
 * - Subscriptions together with resource group names are the cross product, the way the old filter read
 *   them (both had to match).
 * - A resource group name alone is every subscription and resource group pair on record with that name,
 *   whatever its case, in any finding or scan record and at any status. Until now it matched that name in
 *   every subscription, and a pair that no record has yet will not appear later.
 * - A name no record pairs with a subscription, and any resource group under the Directory, is an
 *   unresolved pick: it matches nothing and stays in the filter where it can be seen. The list is never
 *   written empty, which would read as no filter.
 * - A list over `SCOPE_INLINE_BUDGET` characters is stored as a Scope set (ADR 0016), uncapped, since the
 *   server wrote it.
 *
 * A dashboard's widgets are converted with it: category becomes a one-value pick, `policyIds` a Rule override, and
 * a chart's period (or a widget's `windowDays`) a window override. A dashboard config is read through
 * `migrateDashboardConfig` first, so a `findings-table` widget is read as `recent-findings` (only its limit, category
 * and policyIds are read, as 0.13 applied), and a widget stored with no config is read with `{}`. The renames
 * are never written back.
 *
 * Idempotent: a dashboard is converted again only when its legacy values are not the ones it was converted
 * from, a saved view only while its query has no Scope. Pure: rows in, SQL statements out, so SQLite
 * (migrate.ts) and Postgres (pg/bootstrap.ts) run one plan rather than two implementations of it.
 */

/** The subscription and resource group of every finding and every Run History record, at any status. */
export const PAIRS_READ = `SELECT subscription_id, resource_group FROM findings
  WHERE subscription_id <> '' AND resource_group IS NOT NULL AND resource_group <> ''
  UNION
  SELECT subscription_id, resource_group FROM scan_findings
  WHERE subscription_id <> '' AND resource_group IS NOT NULL AND resource_group <> ''`;
export const DASHBOARDS_READ = `SELECT id, config FROM dashboards`;
export const SAVED_VIEWS_READ = `SELECT id, query FROM saved_views`;

export interface PairRow { subscription_id: string; resource_group: string }
export interface DashboardRow { id: string; config: string }
export interface SavedViewRow { id: string; query: string }

/** One statement with `?` placeholders; the Postgres caller binds them positionally. */
export interface ConversionStatement { sql: string; params: string[] }

export interface ConversionPlan {
  statements: ConversionStatement[];
  /** Rows left as they were, with the reason, for the caller to log. They are tried again on the next start. */
  skipped: { kind: 'dashboard' | 'saved view'; id: string; reason: string }[];
}

type Pairs = ReadonlyMap<string, string[]>;

/** The paths of the pairs on record, by lower-cased resource group name. Sorted so the plan is stable. */
export function indexPairs(rows: readonly PairRow[]): Pairs {
  const byName = new Map<string, string[]>();
  const sorted = [...rows].sort((a, b) => a.subscription_id.localeCompare(b.subscription_id) || a.resource_group.localeCompare(b.resource_group));
  for (const { subscription_id: sub, resource_group: group } of sorted) {
    const key = group.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), pairPath(sub, group)]);
  }
  for (const [key, paths] of byName) byName.set(key, distinctPaths(paths));
  return byName;
}

const pairPath = (subscription: string, group: string) => `/subscriptions/${subscription}/resourceGroups/${group}`;

const isDirectory = (subscription: string) => subscription.toLowerCase() === DIRECTORY_SUBSCRIPTION;

/** A path the Scope filter can hold, else an unresolved pick that says what the old filter held. */
function scopeOrUnresolved(path: string, oldText: string): { path: string } | { unresolved: string } {
  const scope = parseScope(path);
  return scope && scope.kind !== 'everything' ? { path } : { unresolved: unresolvedPick(oldText) };
}

/** What the two old lists mean as Scope picks: the paths, and the unresolved picks. Nothing for two empty lists. */
export function resolveLegacyScope(
  subscriptions: readonly string[], resourceGroups: readonly string[], pairs: Pairs,
): { paths: string[]; unresolved: string[] } {
  const paths: string[] = [];
  const unresolved: string[] = [];
  const add = (picked: { path: string } | { unresolved: string }) => {
    if ('path' in picked) paths.push(picked.path); else unresolved.push(picked.unresolved);
  };

  if (resourceGroups.length === 0) {
    for (const sub of subscriptions) add(scopeOrUnresolved(isDirectory(sub) ? DIRECTORY_SCOPE_PATH : `/subscriptions/${sub}`, sub));
  } else if (subscriptions.length > 0) {
    for (const sub of subscriptions) {
      for (const group of resourceGroups) {
        add(isDirectory(sub)
          ? { unresolved: unresolvedPick(`${DIRECTORY_SCOPE_PATH}/${group}`) }
          : scopeOrUnresolved(pairPath(sub, group), `${sub}/${group}`));
      }
    }
  } else {
    for (const group of resourceGroups) {
      const found = pairs.get(group.toLowerCase()) ?? [];
      if (found.length === 0) unresolved.push(unresolvedPick(`resourceGroup/${group}`));
      for (const path of found) add(scopeOrUnresolved(path, group));
    }
  }
  return { paths: distinctPaths(paths), unresolved: [...new Set(unresolved)] };
}

// ---- Scope sets ----

interface ScopeValue {
  /** The picks written inline. */
  scope?: string[];
  /** The hash of the set a long list is stored as. */
  scopeSet?: string;
  /** The set to write for it. */
  set?: { hash: string; paths: string[] };
}

/**
 * How picks are stored: inline when short, else as a set (ADR 0016). A dashboard keeps the unresolved picks
 * inline beside a set of the paths, and a list that is all unresolved stays inline whatever its length. A
 * saved view's query holds a set or an inline list and never both, and an inline list over `SCOPE_INLINE_BUDGET`
 * cannot be written, so there the set holds the unresolved picks too (`unresolvedInSet`). A set is a stored
 * list the server wrote, so it may hold them; they match nothing, and whatever opens a set must show them.
 */
function scopeValue(resolved: { paths: string[]; unresolved: string[] }, unresolvedInSet = false): ScopeValue {
  const all = [...resolved.paths, ...resolved.unresolved];
  if (all.length === 0) return {};
  if (all.join(',').length <= SCOPE_INLINE_BUDGET) return { scope: all };
  if (unresolvedInSet) return setOf(all);
  if (resolved.paths.length === 0) return { scope: all };
  const hash = scopeSetHash(resolved.paths);
  return {
    ...(resolved.unresolved.length > 0 && { scope: resolved.unresolved }),
    scopeSet: hash,
    set: { hash, paths: resolved.paths },
  };
}

/** The picks stored as a set, the form a saved view falls back to when the inline list would not fit its limit. */
function setOf(paths: string[]): ScopeValue {
  const hash = scopeSetHash(paths);
  return { scopeSet: hash, set: { hash, paths } };
}

function setStatement(set: { hash: string; paths: string[] }, now: string): ConversionStatement {
  return {
    sql: `INSERT INTO scope_sets (hash, paths, created_at) VALUES (?, ?, ?) ON CONFLICT (hash) DO NOTHING`,
    params: [set.hash, JSON.stringify(distinctPaths(set.paths)), now],
  };
}

// ---- Dashboards ----

const nonEmpty = <T>(list: T[] | undefined): T[] | undefined => (Array.isArray(list) && list.length > 0 ? list : undefined);
const strings = (list: unknown): string[] => (Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string' && v !== '') : []);

/** The legacy filter values a config holds, empty lists left out and keys in a fixed order, so two configs
 *  with the same values compare as the same JSON. The widgets' values are `legacyWidgetsOf`. */
export function legacyFiltersOf(config: DashboardConfig): LegacyDashboardFilters {
  const out: LegacyDashboardFilters = {};
  const f = config.filters;
  const filters: NonNullable<DashboardConfig['filters']> = {};
  for (const key of ['categories', 'subscriptions', 'resourceGroups', 'tags', 'ruleIds'] as const) {
    const list = nonEmpty(strings(f?.[key]));
    if (list) filters[key] = list;
  }
  const severities = nonEmpty(strings(f?.severities));
  if (severities) filters.severities = severities as NonNullable<typeof filters.severities>;
  if (Object.keys(filters).length > 0) out.filters = filters;
  if (config.dateWindow) out.dateWindow = config.dateWindow;
  if (config.windowDays !== undefined) out.windowDays = config.windowDays;
  return out;
}

export const sameLegacy = (a: LegacyDashboardFilters, b: LegacyDashboardFilters) => JSON.stringify(a) === JSON.stringify(b);

/** The chart types that carry a period of their own, and the days 'all' meant on each (0.13's `periodToDays`). */
const PERIOD_ALL_DAYS: Readonly<Record<string, number>> = { trend: 365, 'new-vs-fixed': 180, 'activity-occurrences': 180 };
const PERIOD_DAYS: Readonly<Record<string, number>> = { '7d': 7, '30d': 30, '90d': 90 };
const DEFAULT_PERIOD_DAYS = 30;

/** A config as the planner reads it: a widget stored with no config reads as `{}`, then the read-time renames. */
function readConfig(config: DashboardConfig): DashboardConfig {
  const widgets = Array.isArray(config.widgets) ? config.widgets : [];
  return migrateDashboardConfig({
    ...config,
    widgets: widgets.map((w): WidgetDef => ({ ...w, config: w.config !== null && typeof w.config === 'object' ? w.config : {} })),
  });
}

/** The override values 0.13 read from a widget's config: category, policyIds, period and windowDays (1, 7 or 30). */
function widgetValuesOf(cfg: Record<string, unknown>): LegacyWidgetValues {
  const out: LegacyWidgetValues = {};
  if (typeof cfg.category === 'string' && cfg.category !== '') out.category = cfg.category;
  const policyIds = nonEmpty(strings(cfg.policyIds));
  if (policyIds) out.policyIds = policyIds;
  if (typeof cfg.period === 'string' && cfg.period !== '') out.period = cfg.period;
  if (cfg.windowDays === 1 || cfg.windowDays === 7 || cfg.windowDays === 30) out.windowDays = cfg.windowDays;
  return out;
}

/** The legacy values of the widgets that hold any, by widget id, of a config already read through `readConfig`. */
function legacyWidgetsOf(config: DashboardConfig): Record<string, LegacyWidgetValues> {
  const out: Record<string, LegacyWidgetValues> = {};
  for (const w of config.widgets) {
    const values = widgetValuesOf(w.config);
    if (typeof w.id === 'string' && Object.keys(values).length > 0) out[w.id] = values;
  }
  return out;
}

/**
 * What a widget's legacy values mean as overrides. Category 'all' and empty lists are Inherit. Only the three
 * chart types read a period: it wins over `windowDays`, and none is 30 days, which is what 0.13 drew. Elsewhere a
 * `windowDays` of 1, 7 or 30 is the window.
 */
function widgetDimensions(type: string, values: LegacyWidgetValues): DashboardDimensionFilters {
  const out: DashboardDimensionFilters = {};
  if (values.category && values.category !== 'all') out.category = [values.category];
  if (values.policyIds) out.rule = values.policyIds;
  const allDays = PERIOD_ALL_DAYS[type];
  const days = allDays !== undefined
    ? (values.period === 'all' ? allDays : PERIOD_DAYS[values.period ?? ''] ?? DEFAULT_PERIOD_DAYS)
    : values.windowDays;
  if (days !== undefined) out.window = { mode: 'relative', days };
  return out;
}

const hasKeys = (value: object) => Object.keys(value).length > 0;
const sameValues = (a: object | undefined, b: object | undefined) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});

/** The widgets of the config with the record's values in place of their config, read the way the config is. */
function recordedWidgets(config: DashboardConfig, record: LegacyDashboardFilters): Record<string, LegacyWidgetValues> {
  const widgets = Array.isArray(config.widgets) ? config.widgets : [];
  return legacyWidgetsOf(readConfig({ ...config, widgets: widgets.map(w => ({ ...w, config: { ...record.widgets?.[w.id] } })) }));
}

/**
 * The dashboard with its filters and widget overrides converted, or null when it needs nothing. The dashboard's
 * own filters need it when they are not the ones it was converted from (none, if it never was), and a widget
 * when its legacy values are not the ones recorded for its id. With no record yet, a widget that holds legacy
 * values needs it, and so does a chart with no overrides of its own, which 0.13 drew over 30 days. A legacy value
 * changed since (a save under 0.13) converts again over the old conversion, and one cleared since converts to
 * no filters. What is not due is left as it is, so overrides set since stay.
 */
export function convertDashboardConfig(
  config: DashboardConfig, pairs: Pairs,
): { config: DashboardConfig; set?: { hash: string; paths: string[] } } | null {
  const view = readConfig(config);
  const legacy = legacyFiltersOf(view);
  const legacyWidgets = legacyWidgetsOf(view);
  const record = config.convertedFrom;
  const recordedLegacy = record ? legacyFiltersOf({ widgets: [], filters: record.filters, dateWindow: record.dateWindow, windowDays: record.windowDays }) : undefined;
  const recordedValues = record ? recordedWidgets(config, record) : undefined;

  const dashboardDue = recordedLegacy ? !sameLegacy(recordedLegacy, legacy) : hasKeys(legacy);
  const rawWidgets = Array.isArray(config.widgets) ? config.widgets : [];
  const widgetDue = view.widgets.map((w, i) => {
    const values = legacyWidgets[w.id] ?? {};
    if (recordedValues) return !sameValues(recordedValues[w.id], values);
    const raw = rawWidgets[i];
    return hasKeys(values) || (PERIOD_ALL_DAYS[w.type] !== undefined && !raw?.dimensionFilters);
  });
  if (!dashboardDue && !widgetDue.includes(true)) return null;

  const next: DashboardConfig = { ...config };
  let set: { hash: string; paths: string[] } | undefined;
  if (dashboardDue) {
    const dimensions: DashboardDimensionFilters = {};
    const f = legacy.filters;
    if (f?.categories) dimensions.category = f.categories;
    const scope = scopeValue(resolveLegacyScope(f?.subscriptions ?? [], f?.resourceGroups ?? [], pairs));
    if (scope.scope) dimensions.scope = scope.scope;
    if (scope.scopeSet) dimensions.scopeSet = scope.scopeSet;
    if (f?.tags) dimensions.tags = f.tags;
    if (f?.severities) dimensions.severity = f.severities;
    if (f?.ruleIds) dimensions.rule = f.ruleIds;
    // The window the dashboard read: `dateWindow`, else the `windowDays` that came before it.
    const window = legacy.dateWindow ?? (legacy.windowDays !== undefined ? { mode: 'relative' as const, days: legacy.windowDays } : undefined);
    if (window) dimensions.window = window;
    next.dimensionFilters = dimensions;
    set = scope.set;
  }
  if (widgetDue.includes(true)) {
    next.widgets = rawWidgets.map((raw, i) => {
      if (!widgetDue[i]) return raw;
      const { dimensionFilters: _previous, ...rest } = raw;
      const dimensions = widgetDimensions(view.widgets[i]!.type, legacyWidgets[view.widgets[i]!.id] ?? {});
      return hasKeys(dimensions) ? { ...rest, dimensionFilters: dimensions } : rest;
    });
  }
  next.convertedFrom = hasKeys(legacyWidgets) ? { ...legacy, widgets: legacyWidgets } : legacy;
  return { config: next, set };
}

// ---- Saved views ----

/** `query` with the picks added as `scope=` or `scopeset=`, or null when no form of it fits the limit. The legacy
 *  `subscription=` and `rg=` stay in the first forms, for a rollback; only a query that cannot fit with them loses them.
 *  A list that fits `SCOPE_INLINE_BUDGET` is written inline, but as a set when the whole query would pass the limit with
 *  it. A saved view holds a set or an inline list, not both, so a set holds the unresolved picks too (`scopeValue`). */
function withScope(
  query: string, resolved: { paths: string[]; unresolved: string[] }, keepLegacy: boolean,
): { query: string; set?: { hash: string; paths: string[] } } | null {
  const preferred = scopeValue(resolved, true);
  const values = preferred.set ? [preferred] : [preferred, setOf([...resolved.paths, ...resolved.unresolved])];
  const bare = withoutLegacyScope(new URLSearchParams(query));
  const bases = keepLegacy ? [query, bare.toString()] : [bare.toString()];
  for (const base of bases) {
    for (const value of values) {
      const added = value.set
        ? new URLSearchParams({ scopeset: value.set.hash })
        : new URLSearchParams({ scope: (value.scope ?? []).map(esc).join(',') });
      const joined = base === '' ? added.toString() : `${base}&${added}`;
      if (joined.length <= MAX_SAVED_VIEW_QUERY_LENGTH) return { query: joined, set: value.set };
    }
  }
  return null;
}

/**
 * The saved view's query with its subscription and resource group converted, or null when it holds neither or
 * already holds a Scope. The upgrade keeps the legacy params beside the Scope for a rollback; a save writes only
 * the new shape (`keepLegacy: false`).
 */
export function convertSavedViewQuery(
  query: string, pairs: Pairs, keepLegacy = true,
): { query: string; set?: { hash: string; paths: string[] } } | 'too-long' | null {
  const params = new URLSearchParams(query);
  if (params.has('scope') || params.has('scopeset')) return null;
  const view = viewFromSearchParams(params);
  const subscriptions = filterValues(view.filters, 'subscription');
  const resourceGroups = filterValues(view.filters, 'resourceGroup');
  if (subscriptions.length === 0 && resourceGroups.length === 0) return null;
  return withScope(query, resolveLegacyScope(subscriptions, resourceGroups, pairs), keepLegacy) ?? 'too-long';
}

// ---- The plan ----

export function planFilterConversion(input: {
  dashboards: readonly DashboardRow[]; savedViews: readonly SavedViewRow[]; pairs: readonly PairRow[]; now: string;
}): ConversionPlan {
  const pairs = indexPairs(input.pairs);
  const plan: ConversionPlan = { statements: [], skipped: [] };

  for (const row of input.dashboards) {
    let config: DashboardConfig;
    try {
      const parsed: unknown = JSON.parse(row.config);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      config = parsed as DashboardConfig;
    } catch {
      plan.skipped.push({ kind: 'dashboard', id: row.id, reason: 'its config cannot be read' });
      continue;
    }
    let converted: ReturnType<typeof convertDashboardConfig>;
    try {
      converted = convertDashboardConfig(config, pairs);
    } catch {
      plan.skipped.push({ kind: 'dashboard', id: row.id, reason: 'its widgets cannot be read' });
      continue;
    }
    if (!converted) continue;
    if (converted.set) plan.statements.push(setStatement(converted.set, input.now));
    plan.statements.push({ sql: `UPDATE dashboards SET config = ? WHERE id = ?`, params: [JSON.stringify(converted.config), row.id] });
  }

  for (const row of input.savedViews) {
    const converted = convertSavedViewQuery(row.query, pairs);
    if (converted === null) continue;
    if (converted === 'too-long') {
      plan.skipped.push({ kind: 'saved view', id: row.id, reason: `its converted query is over ${MAX_SAVED_VIEW_QUERY_LENGTH} characters` });
      continue;
    }
    if (converted.set) plan.statements.push(setStatement(converted.set, input.now));
    plan.statements.push({ sql: `UPDATE saved_views SET query = ? WHERE id = ?`, params: [converted.query, row.id] });
  }
  return plan;
}
