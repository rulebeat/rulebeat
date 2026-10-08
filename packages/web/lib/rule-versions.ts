import { BEFORE_VERSIONING } from './before-versioning';
import {
  CORE_PACK, emptyToNull, kindOfBackend, parseMaybeJson,
  type RuleDefinition, type ShippedCatalogue, type ShippedRule, type VersionScheme,
} from './shipped-catalogue';

/**
 * The pure half of rule seeding (ticket #163, ADR 0004). Given what this build ships and what the
 * database holds, `planRuleSeeding()` returns the list of changes the startup seeder should make.
 * Both seeders (`db/migrate.ts` for SQLite, `db/pg/seeds.ts` for Postgres) run the same plan with
 * their own SQL, so the two backends cannot drift in what an upgrade does.
 *
 * The one rule everything here serves: an upgrade never changes what an enabled shipped rule runs.
 * A new version is recorded beside the running one; only a disabled rule moves to it.
 */

/** The version recorded for a definition that was stored before versions existed and differs from
 *  what ships. It keeps running until an admin switches it. Defined in `before-versioning.ts` so
 *  client code can read it too; re-exported here so existing imports keep working. */
export { BEFORE_VERSIONING };
export const BEFORE_VERSIONING_NOTE = 'The definition this rule had before versions were recorded.';
/** The empty string sorts before every other sort key, so this version is always the oldest. */
export const BEFORE_VERSIONING_SORT_KEY = '';

/** A `rules` row as the seeders read it: JSON columns still as the text the database holds. */
export interface StoredRuleRow {
  id: string;
  name: string;
  description: string;
  category: string;
  severity: string;
  enabled: boolean;
  scope: string;
  resourceTypes: string;
  conditions: string;
  conditionGroups: string | null;
  visualQuery: string | null;
  projectColumns: string | null;
  rawKql: string | null;
  queryBackend: string;
  kind: string;
  graphQuery: string | null;
  logsQuery: string | null;
  type: string;
  pack: string | null;
  version: string | null;
  retiredAt: string | null;
  originRuleId: string | null;
}

export type SeedAction =
  /** A shipped rule this database has never had: insert it and record its version. */
  | { action: 'insert'; rule: ShippedRule }
  /** Make a row a shipped built-in again (or for the first time): type and pack only. */
  | { action: 'adopt'; ruleId: string; pack: string }
  /** A pre-032 Identity row with no Graph query: give it the shipped one so it can run. */
  | { action: 'backfill-graph'; rule: ShippedRule }
  /** Turn a tuned Identity built-in into a custom rule, in place (same id). */
  | { action: 'convert'; ruleId: string; originVersion: string }
  /** Remember a definition under a version. Never changes the rule row. */
  | { action: 'record'; ruleId: string; version: string; sortKey: string; releaseNote: string; definition: RuleDefinition; upstreamRef?: string }
  /** Set which version a row says it runs, without touching its definition. */
  | { action: 'set-running'; ruleId: string; version: string }
  /** Move a disabled rule to a shipped version: writes the definition fields and the version. `kind`
   *  is the install's own kind, carried over so the move never turns an Advisory back into a Problem. */
  | { action: 'apply'; rule: ShippedRule; kind: string }
  | { action: 'retire'; ruleId: string }
  | { action: 'unretire'; ruleId: string };

export interface SeedPlanInput {
  catalogue: ShippedCatalogue;
  rows: StoredRuleRow[];
  /** `versionKey(ruleId, version)` for every row already in `rule_versions`. */
  recorded: Set<string>;
}

export function versionKey(ruleId: string, version: string): string {
  return `${ruleId}\u0000${version}`;
}

// ---- Comparing versions and definitions ------------------------------------------------------

/** Wide enough for any real version part; a longer one is not treated as a number (see below). */
const SORT_PART_WIDTH = 10;

/** The dot-separated numeric parts of a version, at least three, each left-padded with zeros so they
 *  compare correctly as text. Null when any part is not a number that fits. */
function paddedNumericKey(version: string): string | null {
  const parts = version.replace(/^v/i, '').split('.');
  if (!parts.every(p => /^\d{1,10}$/.test(p))) return null;
  while (parts.length < 3) parts.push('0');
  return parts.map(p => p.replace(/^0+(?=\d)/, '').padStart(SORT_PART_WIDTH, '0')).join('.');
}

/**
 * The text a rule's versions are ordered by, oldest to newest, using plain string comparison, so a
 * database can `ORDER BY sort_key` without knowing any scheme. It is stored in `rule_versions` when a
 * version is recorded.
 *  - semver, and an upstream release that is numeric: each part zero-padded to a fixed width;
 *  - upstream-commit-date: the timestamp as UTC ISO text, so offsets and precision do not matter;
 *  - anything the scheme cannot read: the raw text;
 *  - "Before versioning": BEFORE_VERSIONING_SORT_KEY.
 */
export function versionSortKey(scheme: VersionScheme, version: string): string {
  if (version === BEFORE_VERSIONING) return BEFORE_VERSIONING_SORT_KEY;
  if (scheme === 'upstream-commit-date') {
    const time = Date.parse(version);
    return Number.isNaN(time) ? version : new Date(time).toISOString();
  }
  return paddedNumericKey(version) ?? version;
}

/** Negative when `a` is older than `b`, zero when equal, positive when newer. */
export function compareVersions(scheme: VersionScheme, a: string, b: string): number {
  const [ka, kb] = [versionSortKey(scheme, a), versionSortKey(scheme, b)];
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

/** True when two JSON-shaped values hold the same content, whatever order their keys are in. */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a ?? null)) === JSON.stringify(canonical(b ?? null));
}

/** Key-order-independent text for a definition, so two equal definitions always compare equal. */
export function canonicalDefinition(def: RuleDefinition): string {
  return JSON.stringify(canonical(def));
}

export function sameDefinition(a: RuleDefinition, b: RuleDefinition): boolean {
  return canonicalDefinition(a) === canonicalDefinition(b);
}

/** The definition fields of a stored row, in the same shape a shipped definition has. `kind` is the
 *  one field that is not the definition's: whether a rule is a Problem or an Advisory is the
 *  install's choice (#176), so it is taken from the backend, as it is in a shipped definition, and a
 *  row an editor marked Advisory still compares equal to the definition it runs. */
export function definitionOfRow(row: StoredRuleRow): RuleDefinition {
  const queryBackend = row.queryBackend as RuleDefinition['queryBackend'];
  return {
    name: row.name,
    description: row.description,
    category: row.category,
    severity: row.severity,
    queryBackend,
    kind: kindOfBackend(queryBackend),
    resourceTypes: parseMaybeJson<string[]>(row.resourceTypes, []),
    scope: parseMaybeJson<RuleDefinition['scope']>(row.scope, { level: 'resource' }),
    conditions: parseMaybeJson<RuleDefinition['conditions']>(row.conditions, []),
    conditionGroups: emptyToNull(parseMaybeJson<RuleDefinition['conditionGroups']>(row.conditionGroups, null)),
    visualQuery: parseMaybeJson<RuleDefinition['visualQuery']>(row.visualQuery, null),
    projectColumns: emptyToNull(parseMaybeJson<string[] | null>(row.projectColumns, null)),
    rawKql: row.rawKql === '' ? null : row.rawKql,
    graphQuery: parseMaybeJson<RuleDefinition['graphQuery']>(row.graphQuery, null),
    logsQuery: parseMaybeJson<RuleDefinition['logsQuery']>(row.logsQuery, null),
  };
}

/** A definition as the `rules` columns hold it: JSON text for the structured fields. Both seeders
 *  write these, so what a version stores and what a row stores are encoded identically. `kind`
 *  overrides the definition's, for a write to a row that already has one (see `kindAfterApply`). */
export function definitionToColumns(def: RuleDefinition, kind: string = def.kind) {
  return {
    name: def.name,
    description: def.description,
    category: def.category,
    severity: def.severity,
    queryBackend: def.queryBackend,
    kind,
    resourceTypes: JSON.stringify(def.resourceTypes),
    scope: JSON.stringify(def.scope),
    conditions: JSON.stringify(def.conditions),
    conditionGroups: def.conditionGroups ? JSON.stringify(def.conditionGroups) : null,
    visualQuery: def.visualQuery ? JSON.stringify(def.visualQuery) : null,
    projectColumns: def.projectColumns ? JSON.stringify(def.projectColumns) : null,
    rawKql: def.rawKql,
    graphQuery: def.graphQuery ? JSON.stringify(def.graphQuery) : null,
    logsQuery: def.logsQuery ? JSON.stringify(def.logsQuery) : null,
  };
}

// ---- The plan --------------------------------------------------------------------------------

/** The kind a row keeps when a shipped definition is applied over it: Logs is always 'activity',
 *  an Advisory stays Advisory, anything else is a Problem. Never takes the definition's kind. */
export function kindAfterApply(currentKind: string, queryBackend: RuleDefinition['queryBackend']): string {
  if (queryBackend === 'log-analytics') return 'activity';
  return currentKind === 'advisory' ? 'advisory' : 'state';
}

/**
 * What a brand-new row of a shipped rule starts with for the column that belongs to the install
 * rather than to the versioned definition: its kind. This is the only place seeding decides it, and
 * only the `insert` action calls it: a rule that already has a row keeps what it has, whatever a
 * newer version declares (ADR 0005, ADR 0004). Logs rules are always 'activity'.
 */
export function installColumns(rule: ShippedRule): { kind: string } {
  if (rule.definition.queryBackend === 'log-analytics') return { kind: 'activity' };
  return { kind: rule.installDefaults?.kind === 'advisory' ? 'advisory' : 'state' };
}

/** Remembers a stored definition that differs from what ships, so it is never lost. */
function recordBeforeVersioning(ruleId: string, definition: RuleDefinition): SeedAction {
  return {
    action: 'record', ruleId, version: BEFORE_VERSIONING, sortKey: BEFORE_VERSIONING_SORT_KEY,
    releaseNote: BEFORE_VERSIONING_NOTE, definition,
  };
}

/** Keeps a stored definition running, under the "Before versioning" label. */
function runAsBeforeVersioning(ruleId: string, definition: RuleDefinition): SeedAction[] {
  return [recordBeforeVersioning(ruleId, definition), { action: 'set-running', ruleId, version: BEFORE_VERSIONING }];
}

export function planRuleSeeding(input: SeedPlanInput): SeedAction[] {
  const { catalogue, rows, recorded } = input;
  const actions: SeedAction[] = [];
  const shippedById = new Map(catalogue.rules.map(r => [r.id, r]));
  const rowsById = new Map(rows.map(r => [r.id, r]));
  const knownPacks = new Set(catalogue.rules.map(r => r.pack));
  const planned = new Set<string>();

  const record = (rule: ShippedRule) => {
    const key = versionKey(rule.id, rule.version);
    if (recorded.has(key) || planned.has(key)) return;
    planned.add(key);
    actions.push({
      action: 'record', ruleId: rule.id, version: rule.version, sortKey: versionSortKey(rule.versionScheme, rule.version),
      releaseNote: rule.releaseNote, definition: rule.definition, upstreamRef: rule.upstreamRef,
    });
  };

  for (const rule of catalogue.rules) {
    const row = rowsById.get(rule.id);
    if (!row) {
      actions.push({ action: 'insert', rule });
      record(rule);
      continue;
    }
    // A rule that was converted to a custom rule in place is the admin's now, and is never re-seeded.
    if (row.originRuleId !== null) continue;

    // An Identity built-in whose Graph query an admin edited (possible before built-in queries became
    // read-only) cannot stay a built-in, since a built-in's definition now only changes by version.
    // It becomes a custom rule with the same id, so its findings and suppressions stay attached.
    const graphTuned = row.version === null
      && rule.definition.queryBackend === 'microsoft-graph'
      && row.graphQuery !== null
      && !sameValue(parseMaybeJson(row.graphQuery, null), rule.definition.graphQuery);
    if (graphTuned) {
      actions.push({ action: 'convert', ruleId: row.id, originVersion: rule.version });
      continue;
    }

    let effective = row;
    if (row.type !== 'builtin' || row.pack !== rule.pack) {
      actions.push({ action: 'adopt', ruleId: row.id, pack: rule.pack });
    }
    if (rule.definition.queryBackend === 'microsoft-graph' && row.graphQuery === null) {
      actions.push({ action: 'backfill-graph', rule });
      effective = {
        ...row,
        queryBackend: rule.definition.queryBackend,
        kind: rule.definition.kind,
        graphQuery: JSON.stringify(rule.definition.graphQuery),
      };
    }

    record(rule);
    if (row.version === null) {
      // The first start after versions shipped: record what this row actually runs.
      const stored = definitionOfRow(effective);
      if (sameDefinition(stored, rule.definition)) {
        actions.push({ action: 'set-running', ruleId: row.id, version: rule.version });
      } else if (row.enabled) {
        actions.push(...runAsBeforeVersioning(row.id, stored));
      } else {
        // Nothing a disabled rule produces can change, so it moves to what ships; its old definition is kept.
        actions.push(recordBeforeVersioning(row.id, stored), { action: 'apply', rule, kind: kindAfterApply(effective.kind, rule.definition.queryBackend) });
      }
    } else if (!row.enabled && compareVersions(rule.versionScheme, rule.version, row.version) > 0) {
      // A disabled rule always moves to the newest shipped version, "Before versioning" included
      // (its key sorts before every other).
      actions.push({ action: 'apply', rule, kind: kindAfterApply(effective.kind, rule.definition.queryBackend) });
    }

    if (row.retiredAt !== null) actions.push({ action: 'unretire', ruleId: row.id });
  }

  // Rules no pack ships any more. They keep running; they are only labelled.
  for (const row of rows) {
    if (row.type !== 'builtin' || row.originRuleId !== null || shippedById.has(row.id)) continue;
    const pack = row.pack ?? CORE_PACK;
    const retirable = knownPacks.has(pack) || pack === CORE_PACK
      || (catalogue.packsDirRead && !catalogue.unreadablePacks.includes(pack));
    if (!retirable) continue;
    if (row.version === null) actions.push(...runAsBeforeVersioning(row.id, definitionOfRow(row)));
    if (row.retiredAt === null) actions.push({ action: 'retire', ruleId: row.id });
  }

  return actions;
}