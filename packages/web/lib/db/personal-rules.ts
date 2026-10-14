import { db } from './client';
import { personalRules, personalRuleResults, libraryRequests } from './tables';
import { and, desc, eq } from 'drizzle-orm';
import { many, one, run, inTransaction, type DbHandle } from './exec';
import { chunk } from './chunk';
import type {
  Condition, ConditionGroup, GraphQuery, ModuleCategory, QueryBackend, Rule, RuleKind, RuleScope, Severity,
  VisualQuery,
} from '@rulebeat/core';
import type { FindingRow } from '@/lib/finding-rows';

/**
 * Personal rules (#280): a rule one Editor writes and only they see or run. They live in their own
 * tables so that nothing which reads `rules` (the scan runner, the Library, counts, schedules, the
 * shared name check) can ever meet one. Every read and write here takes the owner's id: a row that
 * belongs to someone else reads back exactly like a missing one.
 */

type Row = typeof personalRules.$inferSelect;
type ResultRow = typeof personalRuleResults.$inferSelect;

export type PersonalRunStatus = 'success' | 'failed' | 'capped' | 'invalid';

/** A Personal rule shaped like a Rule, so the rule form takes it as it is. It is always enabled
 *  (the flag has no meaning for a rule that runs only when its author asks) and always `custom`. */
export interface PersonalRule extends Rule {
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  /** JSON of the `{ tenantId, path }` entries the latest run covered; absent until a run. */
  lastRunCoveredScope?: string;
  /** The shared rule this was copied from, while that rule still exists. Set only at creation. */
  sourceRuleId?: string;
  /** The library rule this became, by an approved Library request or a direct copy (#282), while that rule still exists. */
  libraryRuleId?: string;
}

/** One finding of the latest run. */
export interface PersonalRuleResult {
  resourceId?: string;
  resourceName?: string;
  resourceType?: string;
  subscriptionId?: string;
  resourceGroup?: string;
  location?: string;
  severity: Severity;
  title: string;
  rows: FindingRow[];
}

/** The fields a request may set. Everything else (id, owner, times, last run) is the server's. */
export interface PersonalRuleDefinition {
  name: string;
  description: string;
  category: ModuleCategory;
  severity: Severity;
  queryBackend: QueryBackend;
  kind: RuleKind;
  tags?: string[];
  scope: RuleScope;
  resourceTypes: string[];
  conditions: Condition[];
  conditionGroups?: ConditionGroup[];
  projectColumns?: string[];
  rawKql?: string;
  visualQuery?: VisualQuery;
  graphQuery?: GraphQuery;
}

function parseJson<T>(raw: string | null): T | undefined {
  if (!raw) return undefined;
  try { return JSON.parse(raw) as T; } catch { return undefined; }
}

function json(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function rowToRule(row: Row): PersonalRule {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    description: row.description,
    category: row.category,
    severity: row.severity as Severity,
    enabled: true,
    type: 'custom',
    queryBackend: row.queryBackend as QueryBackend,
    kind: row.kind as RuleKind,
    tags: parseJson<string[]>(row.tags),
    scope: parseJson<RuleScope>(row.scope) ?? { level: 'subscription' },
    resourceTypes: parseJson<string[]>(row.resourceTypes) ?? [],
    conditions: parseJson<Condition[]>(row.conditions) ?? [],
    conditionGroups: parseJson<ConditionGroup[]>(row.conditionGroups),
    projectColumns: parseJson<string[]>(row.projectColumns),
    rawKql: row.rawKql ?? undefined,
    visualQuery: parseJson<VisualQuery>(row.visualQuery),
    graphQuery: parseJson<GraphQuery>(row.graphQuery),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastRunAt: row.lastRunAt ?? undefined,
    lastRunStatus: (row.lastRunStatus as PersonalRunStatus | null) ?? undefined,
    lastRunCoveredScope: row.lastRunCoveredScope ?? undefined,
    sourceRuleId: row.sourceRuleId ?? undefined,
    libraryRuleId: row.libraryRuleId ?? undefined,
  };
}

/** The definition fields of a Personal rule and no others: what a Library request snapshots. */
export function definitionOfPersonalRule(rule: PersonalRule): PersonalRuleDefinition {
  return {
    name: rule.name,
    description: rule.description,
    category: rule.category,
    severity: rule.severity,
    queryBackend: rule.queryBackend ?? 'resource-graph',
    kind: rule.kind ?? 'state',
    tags: rule.tags,
    scope: rule.scope,
    resourceTypes: rule.resourceTypes,
    conditions: rule.conditions,
    conditionGroups: rule.conditionGroups,
    projectColumns: rule.projectColumns,
    rawKql: rule.rawKql,
    visualQuery: rule.visualQuery,
    graphQuery: rule.graphQuery,
  };
}

/** Records the library rule a Personal rule became. False when the owner has no such rule. */
export async function setPersonalRuleLibraryRule(
  id: string, ownerId: string, libraryRuleId: string, handle: DbHandle = db,
): Promise<boolean> {
  const existing = await one(
    handle.select({ id: personalRules.id }).from(personalRules)
      .where(and(eq(personalRules.id, id), eq(personalRules.ownerId, ownerId))),
  );
  if (!existing) return false;
  await run(handle.update(personalRules).set({ libraryRuleId }).where(eq(personalRules.id, id)));
  return true;
}

function definitionColumns(def: PersonalRuleDefinition) {
  return {
    name: def.name,
    description: def.description,
    category: def.category,
    severity: def.severity,
    scope: JSON.stringify(def.scope ?? {}),
    resourceTypes: JSON.stringify(def.resourceTypes ?? []),
    conditions: JSON.stringify(def.conditions ?? []),
    conditionGroups: json(def.conditionGroups),
    projectColumns: json(def.projectColumns),
    rawKql: def.rawKql ?? null,
    queryBackend: def.queryBackend,
    graphQuery: json(def.graphQuery),
    kind: def.kind,
    tags: json(def.tags),
    visualQuery: json(def.visualQuery),
  };
}

/** The owner's own rules, newest first. */
export async function listPersonalRules(ownerId: string): Promise<PersonalRule[]> {
  const rows = await many(
    db.select().from(personalRules).where(eq(personalRules.ownerId, ownerId)).orderBy(desc(personalRules.createdAt)),
  );
  return rows.map(rowToRule);
}

/** Null both for a rule that does not exist and for one that belongs to someone else. */
export async function getPersonalRule(id: string, ownerId: string): Promise<PersonalRule | null> {
  const row = await one(
    db.select().from(personalRules).where(and(eq(personalRules.id, id), eq(personalRules.ownerId, ownerId))),
  );
  return row ? rowToRule(row) : null;
}

/** `sourceRuleId` is not part of the definition a request may set: only the copy route passes it. */
export async function createPersonalRule(
  ownerId: string, def: PersonalRuleDefinition, sourceRuleId?: string,
): Promise<PersonalRule> {
  const id = globalThis.crypto.randomUUID();
  const now = new Date().toISOString();
  await run(db.insert(personalRules).values({
    id,
    ownerId,
    ...definitionColumns(def),
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunCoveredScope: null,
    sourceRuleId: sourceRuleId ?? null,
  }));
  return (await getPersonalRule(id, ownerId))!;
}

/** Null when the owner has no such rule. A changed definition leaves the stored results as they are:
 *  they are the latest run's, and say so with their own run time. */
export async function updatePersonalRule(
  id: string, ownerId: string, def: PersonalRuleDefinition,
): Promise<PersonalRule | null> {
  const existing = await getPersonalRule(id, ownerId);
  if (!existing) return null;
  await run(db.update(personalRules)
    .set({ ...definitionColumns(def), updatedAt: new Date().toISOString() })
    .where(and(eq(personalRules.id, id), eq(personalRules.ownerId, ownerId))));
  return getPersonalRule(id, ownerId);
}

/** False when the owner has no such rule. The rule and its results go in one transaction. */
export async function deletePersonalRule(id: string, ownerId: string): Promise<boolean> {
  return inTransaction(async (tx) => {
    const existing = await one(
      tx.select({ id: personalRules.id }).from(personalRules)
        .where(and(eq(personalRules.id, id), eq(personalRules.ownerId, ownerId))),
    );
    if (!existing) return false;
    await run(tx.delete(personalRuleResults).where(eq(personalRuleResults.personalRuleId, id)));
    // Its Library requests stay as history, without the pointer to a rule that no longer exists (#282).
    await run(tx.update(libraryRequests).set({ personalRuleId: null }).where(eq(libraryRequests.personalRuleId, id)));
    await run(tx.delete(personalRules).where(eq(personalRules.id, id)));
    return true;
  });
}

/** The latest run's findings, in the order the run returned them. Empty for a rule the owner does
 *  not have, so a caller must have checked ownership through `getPersonalRule` first. */
export async function listPersonalRuleResults(id: string, ownerId: string): Promise<PersonalRuleResult[]> {
  const rule = await getPersonalRule(id, ownerId);
  if (!rule) return [];
  const rows = await many(
    db.select().from(personalRuleResults)
      .where(eq(personalRuleResults.personalRuleId, id))
      .orderBy(personalRuleResults.ordinal),
  );
  return rows.map(rowToResult);
}

function rowToResult(row: ResultRow): PersonalRuleResult {
  return {
    resourceId: row.resourceId ?? undefined,
    resourceName: row.resourceName ?? undefined,
    resourceType: row.resourceType ?? undefined,
    subscriptionId: row.subscriptionId ?? undefined,
    resourceGroup: row.resourceGroup ?? undefined,
    location: row.location ?? undefined,
    severity: row.severity as Severity,
    title: row.title,
    rows: parseJson<FindingRow[]>(row.rows) ?? [],
  };
}

export interface PersonalRunRecord {
  status: PersonalRunStatus;
  ranAt: string;
  coveredScope: string;
  results: PersonalRuleResult[];
}

/**
 * Stores a run: every result of the previous run is deleted, the new ones inserted and the rule's
 * last run fields set, all in one transaction, so no reader sees a mix of two runs. Returns false
 * when the owner has no such rule (nothing is written).
 */
export async function replacePersonalRuleResults(id: string, ownerId: string, record: PersonalRunRecord): Promise<boolean> {
  return inTransaction(async (tx) => {
    const existing = await one(
      tx.select({ id: personalRules.id }).from(personalRules)
        .where(and(eq(personalRules.id, id), eq(personalRules.ownerId, ownerId))),
    );
    if (!existing) return false;
    await run(tx.delete(personalRuleResults).where(eq(personalRuleResults.personalRuleId, id)));
    const values = record.results.map((r, ordinal) => ({
      personalRuleId: id,
      ordinal,
      resourceId: r.resourceId ?? null,
      resourceName: r.resourceName ?? null,
      resourceType: r.resourceType ?? null,
      subscriptionId: r.subscriptionId ?? null,
      resourceGroup: r.resourceGroup ?? null,
      location: r.location ?? null,
      severity: r.severity,
      title: r.title,
      rows: JSON.stringify(r.rows),
    }));
    for (const part of chunk(values, 50)) {
      await run(tx.insert(personalRuleResults).values(part));
    }
    await run(tx.update(personalRules).set({
      lastRunAt: record.ranAt,
      lastRunStatus: record.status,
      lastRunCoveredScope: record.coveredScope,
    }).where(eq(personalRules.id, id)));
    return true;
  });
}
