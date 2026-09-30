import { inArray } from 'drizzle-orm';
import { db } from './db/client';
import { rules as rulesTable } from './db/tables';
import { many, run, inTransaction } from './db/exec';
import type { Condition, ConditionGroup, GraphQuery, LogAnalyticsQuery, QueryBackend, Rule, RuleExecutionStatus, RuleKind, RuleType, VisualQuery } from '@rulebeat/core';

export async function loadRules(): Promise<Rule[]> {
  return (await many(db.select().from(rulesTable))).map(rowToRule);
}

/**
 * The one place `kind` is computed. Never independently authored or accepted from a client —
 * `ruleToRow()` always calls this rather than trusting `Rule.kind`, so a stale or forged value on
 * the wire can never stick. See the field's own comment in packages/core/src/engine/types.ts.
 */
export function deriveKind(queryBackend: QueryBackend): RuleKind {
  return queryBackend === 'log-analytics' ? 'activity' : 'state';
}

/**
 * Applies to was removed. POST and PUT reject a body that still carries the field rather than
 * silently dropping it, so an API caller finds out the definition would no longer be stored.
 */
export const APPLIES_TO_REMOVED_ERROR = 'Applies to has been removed. Remove the appliesTo field from the request.';

/**
 * Flips just the `enabled` column for a batch of rules — a single `UPDATE ... WHERE id IN (...)`,
 * deliberately not `saveRules()`, which deletes and reinserts every row. Round-tripping 156 rules
 * through `rowToRule`/`ruleToRow` to flip 143 booleans is how a field eventually gets dropped.
 *
 * Unknown ids are reported rather than failing the batch — a stale browser tab must not 404 the
 * whole request over one id that no longer exists.
 */
export async function setRulesEnabled(ids: string[], enabled: boolean): Promise<{ updatedIds: string[]; notFoundIds: string[] }> {
  if (ids.length === 0) return { updatedIds: [], notFoundIds: [] };

  const existingIds = (await many(db.select({ id: rulesTable.id }).from(rulesTable)
    .where(inArray(rulesTable.id, ids)))).map(r => r.id);
  const existingSet = new Set(existingIds);
  const notFoundIds = ids.filter(id => !existingSet.has(id));

  if (existingIds.length > 0) {
    await run(db.update(rulesTable).set({ enabled }).where(inArray(rulesTable.id, existingIds)));
  }

  return { updatedIds: existingIds, notFoundIds };
}

/**
 * Batched per-rule run-outcome write after a scan (spec 030) — grouped by status since every rule
 * in `ids` shares the same outcome and timestamp this call. Mirrors `setRulesEnabled()`: a direct
 * `UPDATE ... WHERE id IN (...)`, not a round-trip through `saveRules()`/`ruleToRow()`, since this
 * runs on every scan and a delete+reinsert of every rule row is the wrong cost for that frequency.
 * Rules outside `ids` (disabled, or excluded by a targeted scan's own rule list) are left untouched,
 * so their last known status still reflects their own last real run.
 */
export async function setRulesLastRunStatus(ids: string[], status: RuleExecutionStatus, at: string): Promise<void> {
  if (ids.length === 0) return;
  await run(db.update(rulesTable).set({ lastRunStatus: status, lastRunAt: at }).where(inArray(rulesTable.id, ids)));
}

export async function saveRules(rules: Rule[]): Promise<void> {
  await inTransaction(async (tx) => {
    await run(tx.delete(rulesTable));
    for (const r of rules) {
      await run(tx.insert(rulesTable).values(ruleToRow(r)));
    }
  });
}

export interface OnboardingRuleSummary {
  id: string;
  category: string;
  severity: Rule['severity'];
  enabled: boolean;
}

/**
 * A light-weight projection of every rule for onboarding step 3's category/severity picker.
 * Deliberately not `loadRules()` handed straight to the client — a rule's KQL, conditions and
 * visual-query blob are several KB each, and the picker only ever needs id/category/severity/enabled
 * to compute counts and build the id lists `PATCH /api/rules/bulk` takes.
 */
export async function listRuleSummaries(): Promise<OnboardingRuleSummary[]> {
  return (await loadRules()).map(r => ({ id: r.id, category: r.category, severity: r.severity, enabled: r.enabled }));
}

export function allTagsFromRules(rules: Rule[]): string[] {
  return [...new Set(rules.flatMap(r => r.tags ?? []))].sort((a, b) => a.localeCompare(b));
}

export async function isNameTaken(name: string, excludeId?: string): Promise<boolean> {
  const all = await loadRules();
  return all.some(r => r.name.trim().toLowerCase() === name.trim().toLowerCase() && r.id !== excludeId);
}

export async function duplicateRule(id: string): Promise<Rule | null> {
  const all = await loadRules();
  const original = all.find(r => r.id === id);
  if (!original) return null;

  const baseName = original.name;
  let candidate = `${baseName} (copy)`;
  let n = 2;
  while (all.some(r => r.name.trim().toLowerCase() === candidate.trim().toLowerCase())) {
    candidate = `${baseName} (copy ${n++})`;
  }

  const copy: Rule = {
    ...original,
    id: globalThis.crypto.randomUUID(),
    name: candidate,
    type: 'custom',
    pack: undefined,
    enabled: false,
  };

  await saveRules([...all, copy]);
  return copy;
}

// --- helpers ---

function migrateScope(raw: Rule['scope'] & { include?: string[]; exclude?: string[] }): Rule['scope'] {
  const scope: Rule['scope'] = { level: raw.level };
  if (raw.subscriptions?.length) scope.subscriptions = raw.subscriptions;
  else if (raw.include?.length) scope.subscriptions = raw.include;
  if (raw.managementGroups?.length) scope.managementGroups = raw.managementGroups;
  return scope;
}

type Row = typeof rulesTable.$inferSelect;

function uid(): string {
  return globalThis.crypto.randomUUID();
}

function rowToRule(row: Row): Rule {
  // Read conditions (new name); fall back to 'rules' column (legacy name stored during migration window)
  const rawConditions = row.conditions ?? '[]';
  const conditions = JSON.parse(rawConditions) as Condition[];

  // Migrate legacy filter conditions into conditions (one-time, non-destructive).
  const legacyFilters = row.filter ? (JSON.parse(row.filter) as Condition[]) : [];
  const migratedConditions: Condition[] = legacyFilters.map(c => ({ id: uid(), ...c }));

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category as Rule['category'],
    severity: row.severity as Rule['severity'],
    enabled: Boolean(row.enabled),
    type: (row.type ?? 'custom') as RuleType,
    pack: row.pack ?? undefined,
    group: row.group ?? undefined,
    tags: row.tags ? JSON.parse(row.tags) as string[] : (row.group ? [row.group] : undefined),
    scope: migrateScope(JSON.parse(row.scope) as Rule['scope'] & { include?: string[]; exclude?: string[] }),
    resourceTypes: JSON.parse(row.resourceTypes) as string[],
    conditions: [...migratedConditions, ...conditions],
    conditionGroups: row.conditionGroups ? JSON.parse(row.conditionGroups) as ConditionGroup[] : undefined,
    projectColumns: row.projectColumns ? JSON.parse(row.projectColumns) as string[] : undefined,
    rawKql: row.rawKql ?? undefined,
    visualQuery: row.visualQuery ? JSON.parse(row.visualQuery) as VisualQuery : undefined,
    queryBackend: row.queryBackend as QueryBackend,
    kind: row.kind as RuleKind,
    graphQuery: row.graphQuery ? JSON.parse(row.graphQuery) as GraphQuery : undefined,
    logsQuery: row.logsQuery ? JSON.parse(row.logsQuery) as LogAnalyticsQuery : undefined,
    lastRunStatus: (row.lastRunStatus as RuleExecutionStatus | null) ?? undefined,
    lastRunAt: row.lastRunAt ?? undefined,
  };
}

function ruleToRow(r: Rule): typeof rulesTable.$inferInsert {
  const queryBackend = r.queryBackend ?? 'resource-graph';
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    category: r.category,
    severity: r.severity,
    enabled: r.enabled,
    scope: JSON.stringify(r.scope),
    resourceTypes: JSON.stringify(r.resourceTypes),
    filter: null,   // no longer used; kept as null for DB column compatibility
    conditions: JSON.stringify(r.conditions),
    conditionGroups: r.conditionGroups?.length ? JSON.stringify(r.conditionGroups) : null,
    projectColumns: r.projectColumns?.length ? JSON.stringify(r.projectColumns) : null,
    rawKql: r.rawKql ?? null,
    type: r.type ?? 'custom',
    pack: r.pack ?? null,
    group: r.group ?? null,
    tags: r.tags?.length ? JSON.stringify(r.tags) : null,
    visualQuery: r.visualQuery ? JSON.stringify(r.visualQuery) : null,
    queryBackend,
    kind: deriveKind(queryBackend),
    graphQuery: r.graphQuery ? JSON.stringify(r.graphQuery) : null,
    logsQuery: r.logsQuery ? JSON.stringify(r.logsQuery) : null,
    lastRunStatus: r.lastRunStatus ?? null,
    lastRunAt: r.lastRunAt ?? null,
  };
}
