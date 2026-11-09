/**
 * The conditions a view's Scope, Rule source and First seen filters put on the `findings` table, and the
 * states of the values the address names (lib/filter-states.ts). Read inside the view's own transaction, so
 * the stored management group tree, the rules and the findings are one moment of the database.
 *
 *  - Scope: the picks are matched by the access filter's placement table (ADR 0015), through the same SQL
 *    that narrows by Access, and the result is ANDed with Access by the caller, so a pick never widens.
 *    The tree is the stored copy; Azure is never asked.
 *  - Rule source: the findings whose rule is, in its current definition, from the pack, Community or Custom.
 *    A built-in with no pack is RuleBeat Core, a copy of a built-in is Custom, and a retired built-in keeps
 *    its pack. A rule that is not a row of `rules` (a Personal rule) matches no source.
 *  - Age: how long ago a finding was first seen, in whole UTC days, resolved on read so it keeps rolling.
 *    It reads the finding's first seen day alone, apart from the window, the status and the First seen funnel.
 */
import { and, eq, gte, lt, or, sql, type SQL } from 'drizzle-orm';
import type { Access } from '../access-model';
import { many } from './exec';
import type { DbHandle } from './exec';
import { findings as findingsTable, managementGroupHierarchy as hierarchyTable, rules as rulesTable } from './tables';
import { accessFilterSql } from './access-filter';
import { expandScopeSetOn } from './scope-sets';
import type { HierarchyNode } from '../management-group-tree';
import { filterValues, type AgeRange, type View } from '../finding-view';
import { COMMUNITY_SOURCE, CUSTOM_SOURCE, NO_FILTER_STATES, sourceLabel, type FilterStates, type SourceValueState } from '../filter-states';
import type { PackManifestLabels } from '../pack-labels';
import packManifest from '@/data/packs/pack-manifest.json';
import { picksAsAccess, readPicks, scopePickStates } from '../scope-picks';
import type { LegacyResolution } from './legacy-scope-link';
import { CORE_PACK } from '../shipped-catalogue';
import type { ExplorerCategory, RuleDetails } from '../view-response';

export interface ViewFilterPlan {
  /** The condition on the findings table, or undefined when the view has none of these filters. */
  condition: SQL | undefined;
  states: FilterStates;
}

/** The stored tree on the view's own transaction, so it is the same moment of the database as the findings.
 *  (`listHierarchyNodes()` reads on the shared handle.) */
async function readHierarchy(tx: DbHandle): Promise<HierarchyNode[]> {
  const rows = await many(tx.select().from(hierarchyTable));
  return rows.flatMap((row): HierarchyNode[] => (
    row.kind === 'managementGroup' || row.kind === 'subscription'
      ? [{ tenantId: row.tenantId, kind: row.kind, id: row.nodeId, name: row.displayName, parentId: row.parentId }]
      : []
  ));
}

const NOTHING = sql`1 = 0`;

// ---- Rule source ----

/** The rows of `rules` a source value stands for. */
function sourceRules(value: string): SQL {
  if (value === COMMUNITY_SOURCE) return eq(rulesTable.type, 'community');
  if (value === CUSTOM_SOURCE) return eq(rulesTable.type, 'custom');
  return and(eq(rulesTable.type, 'builtin'), sql`coalesce(${rulesTable.pack}, ${CORE_PACK}) = ${value}`)!;
}

function sourceCondition(values: readonly string[]): SQL {
  const rows = values.map(sourceRules);
  return sql`${findingsTable.ruleId} IN (SELECT ${rulesTable.id} FROM ${rulesTable} WHERE ${rows.length === 1 ? rows[0] : or(...rows)})`;
}

/** The packs some built-in rule carries now. */
async function readPacks(tx: DbHandle): Promise<Set<string>> {
  const rows = await many(tx.select({ pack: rulesTable.pack }).from(rulesTable).where(eq(rulesTable.type, 'builtin')));
  return new Set(rows.map(r => r.pack ?? CORE_PACK));
}

async function sourceStates(tx: DbHandle, values: readonly string[]): Promise<SourceValueState[]> {
  if (values.length === 0) return [];
  const packs = await readPacks(tx);
  return values.map(value => ({
    value,
    label: sourceLabel(value, packManifest as PackManifestLabels),
    exists: value === COMMUNITY_SOURCE || value === CUSTOM_SOURCE || packs.has(value),
  }));
}

// ---- Age ----

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysBefore(today: string, days: number): string {
  return dayKey(new Date(Date.parse(`${today}T00:00:00Z`) - days * DAY_MS));
}

/** The findings first seen from `min` to `max` whole UTC days before today. A finding stores when it was first
 *  seen as an ISO time, so a day key compares as the start of that day. */
function ageCondition(age: AgeRange, now: Date): SQL {
  const today = dayKey(now);
  const newest = daysBefore(today, age.min - 1);
  const conditions: SQL[] = [lt(findingsTable.firstSeenAt, newest)];
  if (age.max !== null) conditions.push(gte(findingsTable.firstSeenAt, daysBefore(today, age.max)));
  return and(...conditions)!;
}

// ---- The plan ----

/**
 * What `view`'s Scope, Rule source and First seen filters put on the findings `access` can see, and the
 * state of each value of those filters and of its tags and categories. `now` is when the age is measured from.
 */
export async function planViewFilters(
  tx: DbHandle, view: View, access: Access,
  context: { rules: ReadonlyMap<string, RuleDetails>; categories: readonly ExplorerCategory[]; legacy?: Pick<LegacyResolution, 'paths' | 'gone'> },
  now: Date = new Date(),
): Promise<ViewFilterPlan> {
  const conditions: SQL[] = [];
  const states: FilterStates = { scope: [], scopeHidden: { outside: 0, outsideNarrowed: 0 }, scopeUnresolved: false, source: [], missingTags: [], deletedCategories: [], legacyGone: context.legacy?.gone ?? NO_FILTER_STATES.legacyGone };

  // A long Scope list arrives as a hash and only the server opens it (ADR 0016). A hash no row holds is not the
  // same as no pick, which would show everything held: it matches nothing.
  const expansion = view.scopeSet ? await expandScopeSetOn(tx, view.scopeSet) : null;
  const scope = expansion ? (expansion.status === 'resolved' ? expansion.paths : undefined) : view.scope;
  if (expansion?.status === 'unresolved') {
    states.scopeUnresolved = true;
    conditions.push(NOTHING);
  } else if (scope && scope.length > 0) {
    const nodes = await readHierarchy(tx);
    const picks = readPicks(scope);
    const picked = picks.length === 0 ? undefined : accessFilterSql(picksAsAccess(picks, nodes));
    conditions.push(picked ?? NOTHING);
    const pickStates = scopePickStates(access, scope, nodes);
    if (expansion) {
      // A set is never sent to the browser whole: it names the picks the viewer holds and counts the rest.
      states.scope = pickStates.filter(s => s.access === 'held' || s.access === 'narrowed' || s.access === 'unresolved');
      states.scopeHidden = {
        outside: pickStates.filter(s => s.access === 'outside').length,
        outsideNarrowed: pickStates.filter(s => s.access === 'outside-narrowed').length,
      };
    } else {
      states.scope = pickStates;
    }
  }

  // The held pairs an old link's subscription and resource group values translate to, matched like any other pick
  // and ANDed with the rest. No pair is not the same as no filter: the old values were a filter, and match nothing.
  if (context.legacy?.paths) {
    const picks = readPicks(context.legacy.paths);
    conditions.push((picks.length === 0 ? undefined : accessFilterSql(picksAsAccess(picks, await readHierarchy(tx)))) ?? NOTHING);
  }

  if (view.source && view.source.length > 0) {
    conditions.push(sourceCondition(view.source));
    states.source = await sourceStates(tx, view.source);
  }

  if (view.age) conditions.push(ageCondition(view.age, now));

  const carried = new Set([...context.rules.values()].flatMap(r => r.tags ?? []));
  states.missingTags = filterValues(view.filters, 'tags').filter(tag => !carried.has(tag));
  const categoryIds = new Set(context.categories.map(c => c.id));
  states.deletedCategories = filterValues(view.filters, 'category').filter(id => !categoryIds.has(id));

  return { condition: conditions.length === 0 ? undefined : and(...conditions), states };
}
