/**
 * Reads a database without caring which era's column names it uses.
 *
 * The whole point of the upgrade suite is comparing a database before and after, and "before" might
 * keep a rule's conditions in a column called `rules`, its provenance in `source`, and the rows
 * themselves in a table called `policies`. Normalising that here means an assertion can be written
 * once — "the three custom rules are still there with their logic intact" — and run against every
 * shape.
 */
import type { Database } from 'better-sqlite3';
import { columnsOf, tableExists } from './dump';

export interface NormalisedRule {
  id: string;
  name: string;
  enabled: number;
  category: string;
  severity: string;
  /** `conditions` now, `rules` in the oldest lineage. */
  conditions: string | null;
  /** `condition_groups` now, `rule_groups` before. */
  conditionGroups: string | null;
  /** `type` now, `source` before. */
  type: string | null;
  rawKql: string | null;
  tags: string | null;
  groupName: string | null;
  /** Absent on any database that predates spec 029's migration. */
  queryBackend: string | null;
  shape: string | null;
  kind: string | null;
}

/** Where rules live in this database — the table was called `policies` in the oldest lineage. */
export function ruleTableName(sqlite: Database): 'rules' | 'policies' | null {
  if (tableExists(sqlite, 'rules')) return 'rules';
  if (tableExists(sqlite, 'policies')) return 'policies';
  return null;
}

/**
 * Every rule, with era-specific column names mapped onto one shape. Reads whichever of each column
 * pair exists, so it works equally on a fixture and on an upgraded database.
 */
export function readRules(sqlite: Database, table?: 'rules' | 'policies'): NormalisedRule[] {
  const t = table ?? ruleTableName(sqlite);
  if (!t) return [];

  const cols = new Set(columnsOf(sqlite, t));
  const pick = (...names: string[]) => names.find(n => cols.has(n)) ?? null;

  const conditionsCol = pick('conditions', 'rules');
  const groupsCol = pick('condition_groups', 'rule_groups');
  const typeCol = pick('type', 'source');

  const rows = sqlite.prepare(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[];
  return rows.map(r => ({
    id: String(r.id),
    name: String(r.name),
    enabled: Number(r.enabled),
    category: String(r.category),
    severity: String(r.severity),
    conditions: str(conditionsCol ? r[conditionsCol] : null),
    conditionGroups: str(groupsCol ? r[groupsCol] : null),
    type: str(typeCol ? r[typeCol] : null),
    rawKql: str(cols.has('raw_kql') ? r.raw_kql : null),
    tags: str(cols.has('tags') ? r.tags : null),
    groupName: str(cols.has('group_name') ? r.group_name : null),
    queryBackend: str(cols.has('query_backend') ? r.query_backend : null),
    shape: str(cols.has('shape') ? r.shape : null),
    kind: str(cols.has('kind') ? r.kind : null),
  }));
}

/**
 * Rules are matched by *name*, not id, because several migrations legitimately rewrite ids. A rule
 * that survived under a new id has survived; one that vanished has not.
 */
export function ruleByName(sqlite: Database, name: string): NormalisedRule | undefined {
  return readRules(sqlite).find(r => r.name === name);
}

/** Reads a table if it exists, else an empty list — old shapes are missing whole tables. */
export function rowsIfPresent(sqlite: Database, table: string): Record<string, unknown>[] {
  if (!tableExists(sqlite, table)) return [];
  return sqlite.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[];
}

function str(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}
