/**
 * Held-back values (#363, ADR 0012): which stored filter values of a dashboard or a saved view sit outside
 * a person's Access, and the item as it leaves the server without them. The words and the lookups the
 * components share are in lib/held-back.ts.
 *
 *  - A **Scope** value (a subscription, a resource group, the reserved Directory value) is held back when
 *    the person holds no Scope that covers it and none inside it. The Access alone decides.
 *  - A **resourceName** or `row.*` value is held back unless a finding inside the person's Access carries
 *    it, whatever its status and suppressed or not. One findings query through the access filter answers
 *    every value of a request.
 *  - **Everything** holds nothing back and is never queried for it.
 *  - Free-text search and the rule, category, tag, severity and date-window values are never held back.
 *
 * The stored item is not changed: this only decides what leaves the server. A person who saves a trimmed item
 * back (their own Personal one, or a Shared one they may change) writes what they were sent, so a held-back
 * value in an item they change does not survive the save.
 */
import type { Access } from '../access-model';
import { OUTSIDE_ACCESS_LABEL, type HeldBack, type HeldBackPlace } from '../held-back';
import { markOutsideAccess } from '../outside-access';
import {
  findingSubject, isRowField, readPath, rowPath, valueText, viewFromSearchParams, viewToSearchParams,
  type View, type ViewFilter,
} from '../finding-view';
import type { DashboardConfig } from '../types';
import { accessFilterSql } from './access-filter';
import { CHUNK_SIZE, chunk } from './chunk';
import { inReadTransaction, many } from './exec';
import { findings as findingsTable } from './tables';
import { loadFindingRows, rowToRecordFromColumns, rowsTableReady } from './findings';

/** The stored values of one dimension in one place, as the item holds them. */
export interface StoredValues {
  place: HeldBackPlace;
  id: string;
  /** The filter's field name: `subscription`, `resourceGroup`, `resourceName` or `row.<path>`. */
  dimension: string;
  values: readonly string[];
}

/** The held-back values per dimension, each as it was stored. A dimension with none is absent. */
export type HeldValues = ReadonlyMap<string, ReadonlySet<string>>;

/** What the findings inside an Access carry of the values asked about. */
export interface Carried {
  /** The resource names (as the Resource column shows them) among those asked about that a finding carries. */
  names: ReadonlySet<string>;
  /** By row path, the values among those asked about that a row of a finding carries. */
  rows: ReadonlyMap<string, ReadonlySet<string>>;
}
/** The values to look for, in the same shape as what is found. */
export type Wanted = Carried;
export type CarriedReader = (access: Access, wanted: Wanted) => Promise<Carried>;

const SCOPE_DIMENSIONS = ['subscription', 'resourceGroup'] as const;
type ScopeDimension = (typeof SCOPE_DIMENSIONS)[number];

const isScopeDimension = (dimension: string): dimension is ScopeDimension => (SCOPE_DIMENSIONS as readonly string[]).includes(dimension);
const isHeldDimension = (dimension: string) => isScopeDimension(dimension) || dimension === 'resourceName' || isRowField(dimension);

/**
 * The one findings query: every finding inside `access`, to read the names they show, and then their rows, a chunk
 * of findings at a time and only until every value asked about has been found.
 */
const readCarried: CarriedReader = (access, wanted) => inReadTransaction(async (tx) => {
  const t = findingsTable;
  const where = accessFilterSql(access);
  const inside = await many(tx.select({
    fingerprint: t.fingerprint, resourceName: t.resourceName, dimensionKey: t.dimensionKey, resourceId: t.resourceId,
  }).from(t).where(where));

  const names = new Set<string>();
  if (wanted.names.size > 0) {
    for (const f of inside) {
      const subject = findingSubject({
        resourceName: f.resourceName ?? undefined, dimensionKey: f.dimensionKey ?? undefined, resourceId: f.resourceId ?? undefined,
      });
      if (wanted.names.has(subject)) names.add(subject);
    }
  }

  const rows = new Map<string, Set<string>>([...wanted.rows.keys()].map(path => [path, new Set<string>()]));
  if (wanted.rows.size === 0) return { names, rows };

  const allFound = () => [...wanted.rows].every(([path, values]) => rows.get(path)!.size === values.size);
  const read = (row: unknown) => {
    for (const [path, values] of wanted.rows) {
      const value = valueText(readPath(row, path));
      if (values.has(value)) rows.get(path)!.add(value);
    }
  };

  if (!(await rowsTableReady(tx))) {
    const stored = await many(tx.select().from(t).where(where));
    for (const row of stored) for (const r of rowToRecordFromColumns(row).rows) read(r);
    return { names, rows };
  }
  for (const fpChunk of chunk(inside.map(f => f.fingerprint), CHUNK_SIZE)) {
    for (const found of (await loadFindingRows(tx, fpChunk)).values()) for (const row of found) read(row);
    if (allFound()) break;
  }
  return { names, rows };
});

/**
 * Which of the `stored` values are outside `access`. `read` is how the findings are asked, and is not
 * called when nothing asks about a resource name or a returned column, or for Everything.
 */
export async function heldBackValues(
  access: Access, stored: readonly StoredValues[], read: CarriedReader = readCarried,
): Promise<HeldValues> {
  const held = new Map<string, Set<string>>();
  if (access.everything) return held;

  const asked = new Map<string, Set<string>>();
  for (const s of stored) {
    if (!isHeldDimension(s.dimension) || s.values.length === 0) continue;
    const set = asked.get(s.dimension) ?? new Set<string>();
    for (const value of s.values) set.add(value);
    asked.set(s.dimension, set);
  }
  const hold = (dimension: string, values: Iterable<string>) => {
    const set = held.get(dimension) ?? new Set<string>();
    for (const value of values) set.add(value);
    if (set.size > 0) held.set(dimension, set);
  };

  const outside = markOutsideAccess(access, {
    subscriptions: [...asked.get('subscription') ?? []], resourceGroups: [...asked.get('resourceGroup') ?? []],
  });
  hold('subscription', outside.subscriptions);
  hold('resourceGroup', outside.resourceGroups);

  const wanted: Wanted = {
    names: asked.get('resourceName') ?? new Set(),
    rows: new Map([...asked].filter(([dimension]) => isRowField(dimension)).map(([dimension, values]) => [rowPath(dimension as `row.${string}`), values])),
  };
  if (wanted.names.size > 0 || wanted.rows.size > 0) {
    const carried = await read(access, wanted);
    hold('resourceName', [...wanted.names].filter(name => !carried.names.has(name)));
    for (const [path, values] of wanted.rows) hold(`row.${path}`, [...values].filter(value => !carried.rows.get(path)?.has(value)));
  }
  return held;
}

const isHeld = (held: HeldValues, dimension: string, value: string) => held.get(dimension)?.has(value) ?? false;

/** One count per place and dimension for the stored values that are held back. */
function countsOf(stored: readonly StoredValues[], held: HeldValues): HeldBack[] {
  return stored.flatMap(s => {
    const count = new Set(s.values.filter(value => isHeld(held, s.dimension, value))).size;
    return count > 0 ? [{ place: s.place, id: s.id, dimension: s.dimension, count }] : [];
  });
}

// ---- Dashboards ----

const DASHBOARD_KEYS = [['subscriptions', 'subscription'], ['resourceGroups', 'resourceGroup']] as const;

const stringsOf = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined);

/** The Scope values a dashboard stores: its filter bar's, and each widget's override. */
function dashboardValues(id: string, config: DashboardConfig): StoredValues[] {
  const out: StoredValues[] = [];
  for (const [key, dimension] of DASHBOARD_KEYS) {
    const values = stringsOf(config.filters?.[key]);
    if (values?.length) out.push({ place: 'dashboard', id, dimension, values });
  }
  for (const widget of config.widgets ?? []) {
    for (const [key, dimension] of DASHBOARD_KEYS) {
      const values = stringsOf((widget.config ?? {})[key]);
      if (values?.length) out.push({ place: 'widget', id: widget.id, dimension, values });
    }
  }
  return out;
}

/** The config with every held-back value taken out of the filter bar and the widgets' overrides. */
function trimConfig(config: DashboardConfig, held: HeldValues): DashboardConfig {
  const without = (values: unknown, dimension: string) => (Array.isArray(values) ? values.filter(v => typeof v !== 'string' || !isHeld(held, dimension, v)) : values);
  const filters = config.filters && { ...config.filters };
  const widgets = (config.widgets ?? []).map(widget => {
    const own = { ...(widget.config ?? {}) };
    for (const [key, dimension] of DASHBOARD_KEYS) if (key in own) own[key] = without(own[key], dimension);
    return { ...widget, config: own };
  });
  if (filters) for (const [key, dimension] of DASHBOARD_KEYS) if (filters[key]) filters[key] = without(filters[key], dimension) as string[];
  return { ...config, ...(filters ? { filters } : {}), widgets };
}

/**
 * Dashboards as the routes and pages return them: each without the stored values `access` does not reach,
 * with a count for the filter bar and for each widget that held some. One findings query serves the lot.
 */
export async function holdBackDashboards<T extends { id: string; config: DashboardConfig }>(
  access: Access, dashboards: readonly T[],
): Promise<(T & { heldBack: HeldBack[] })[]> {
  const stored = dashboards.map(d => dashboardValues(d.id, d.config));
  const held = await heldBackValues(access, stored.flat());
  return dashboards.map((d, i) => {
    const heldBack = countsOf(stored[i]!, held);
    return { ...d, config: heldBack.length > 0 ? trimConfig(d.config, held) : d.config, heldBack };
  });
}

// ---- Saved views ----

/** The Scope, resource name and returned-column filters of a saved view, in the order the view lists them. */
function viewValues(id: string, view: View): StoredValues[] {
  return view.filters.filter(f => isHeldDimension(f.field)).map(f => ({ place: 'savedView', id, dimension: f.field, values: f.values }));
}

/** Saved views as the routes return them: each query without the stored values `access` does not reach, and
 *  a count per dimension. A dimension with every value held back keeps the placeholder `OUTSIDE_ACCESS_LABEL`. A query with nothing held back is returned exactly as stored. */
export async function holdBackSavedViews<T extends { id: string; query: string }>(
  access: Access, views: readonly T[],
): Promise<(T & { heldBack: HeldBack[] })[]> {
  const parsed = views.map(v => viewFromSearchParams(new URLSearchParams(v.query)));
  const stored = views.map((v, i) => viewValues(v.id, parsed[i]!));
  const held = await heldBackValues(access, stored.flat());
  return views.map((v, i) => {
    const heldBack = countsOf(stored[i]!, held);
    if (heldBack.length === 0) return { ...v, heldBack };
    // A dimension whose values are all held back keeps one placeholder that no finding carries, so opening the
    // view lists nothing for this person. Dropping the filter instead would list the whole of their Access.
    const filters = parsed[i]!.filters.map((f): ViewFilter => {
      if (!isHeldDimension(f.field)) return f;
      const values = f.values.filter(value => !isHeld(held, f.field, value));
      return { ...f, values: values.length > 0 || f.values.length === 0 ? values : [OUTSIDE_ACCESS_LABEL] } as ViewFilter;
    }).filter(f => f.values.length > 0);
    return { ...v, query: viewToSearchParams({ ...parsed[i]!, filters }).toString(), heldBack };
  });
}
