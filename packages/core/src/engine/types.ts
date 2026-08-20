import type { ModuleCategory, RemediationStep, Severity } from '../types.js';

// ── Visual Query Builder types ────────────────────────────────────────────────
// Block-based pipeline model. Each QueryStage maps 1:1 to one KQL | clause.
// Layers: 1=FilterStage, 2=ComputeStage, 3=ExpandStage+AggregateStage,
//         4=JoinStage, 5=SortStage+LimitStage+ShapeStage

// ── Layer 1: | where ──────────────────────────────────────────────────────────

export type VisualFilterOperator =
  | 'exists' | 'notExists' | 'isNull' | 'isNotNull' | 'isEmpty' | 'isNotEmpty'
  | 'isTrue' | 'isFalse'
  | 'equals' | 'notEquals' | 'contains' | 'notContains'
  | 'startsWith' | 'notStartsWith' | 'endsWith' | 'notEndsWith'
  | 'matchesRegex' | 'has' | 'notHas' | 'hasAny'
  | 'gt' | 'gte' | 'lt' | 'lte' | 'between'
  | 'olderThanDays' | 'withinLastDays'
  | 'arrayEmpty' | 'arrayNotEmpty' | 'arrayLengthGt' | 'arrayLengthLte' | 'arrayContains'
  | 'in' | 'notIn'
  // Parser-only, never offered in the operator dropdown: a condition the builder has no operator
  // for, carried through verbatim in `rawExpr`. The builder deliberately reads more KQL than it can
  // author (same deal the advanced stages get) — what it can't express, it must not drop.
  | 'raw';

export interface VisualFilterCondition {
  id: string;
  join?: 'and' | 'or';
  field: string;
  operator: VisualFilterOperator;
  value?: string;
  value2?: string;   // upper bound for 'between'
  values?: string[]; // for 'in', 'notIn', 'hasAny'
  rawExpr?: string;  // operator='raw' — the original KQL, written back out untouched
}

export interface VisualFilterGroup {
  id: string;
  join?: 'and' | 'or';
  conditions: VisualFilterCondition[];
}

export interface FilterStage {
  id: string;
  type: 'filter';
  label?: string;
  groups: VisualFilterGroup[];
}

// ── Layer 2: | extend ─────────────────────────────────────────────────────────

export interface ComputedColumn {
  id: string;
  alias: string;
  exprType: 'field' | 'function' | 'raw';
  field?: string;      // exprType='field'
  fnName?: string;     // exprType='function'
  fnArgs?: string[];   // exprType='function' — each arg as raw KQL string
  rawExpr?: string;    // exprType='raw'
}

export interface ComputeStage {
  id: string;
  type: 'compute';
  columns: ComputedColumn[];
}

// ── Layer 3a: | mv-expand ─────────────────────────────────────────────────────

export interface ExpandStage {
  id: string;
  type: 'expand';
  field: string;
  alias?: string;
}

// ── Layer 3b: | summarize ─────────────────────────────────────────────────────

export type AggFn = 'count' | 'countif' | 'sum' | 'avg' | 'min' | 'max' | 'dcount' | 'make_list' | 'make_set' | 'any';

export interface AggregateColumn {
  id: string;
  alias: string;
  fn: AggFn;
  field?: string;
  condition?: string; // for countif(condition)
}

export interface AggregateStage {
  id: string;
  type: 'aggregate';
  columns: AggregateColumn[];
  groupBy: string[];
}

// ── Layer 4: | join ───────────────────────────────────────────────────────────

export type JoinKind = 'inner' | 'leftouter' | 'rightouter' | 'fullouter' | 'leftsemi' | 'leftanti' | 'rightsemi' | 'rightanti';

export interface JoinStage {
  id: string;
  type: 'join';
  kind: JoinKind;
  rightQuery: string; // raw KQL for the right-side subquery inside (...)
  onLeft: string;     // left-side join key
  onRight: string;    // right-side join key
}

// ── Layer 5: output shaping ───────────────────────────────────────────────────

export interface SortColumn {
  field: string;
  direction: 'asc' | 'desc';
}

export interface SortStage {
  id: string;
  type: 'sort';
  columns: SortColumn[];
}

export interface LimitStage {
  id: string;
  type: 'limit';
  mode: 'take' | 'top';
  count: number;
  orderBy?: SortColumn; // only for mode='top'
}

export interface ShapeStage {
  id: string;
  type: 'shape';
  mode: 'project' | 'project-away';
  columns: string[];
}

// ── Passthrough: clauses the builder can parse but not author ────────────────

// Parser-only, never offered in the "Add stage" menu — same deal as
// VisualFilterOperator's 'raw' and ComputedColumn's exprType='raw': what the builder
// can't express, it must not drop. Currently only produced for `| union (...)`.
export interface RawStage {
  id: string;
  type: 'raw';
  clause: string; // verbatim clause text, without the leading '|'
}

// ── Full stage union ──────────────────────────────────────────────────────────

export type QueryStage =
  | FilterStage
  | ComputeStage
  | ExpandStage
  | AggregateStage
  | JoinStage
  | SortStage
  | LimitStage
  | ShapeStage
  | RawStage;

export interface VisualQuery {
  stages: QueryStage[];
}

// ── Rule engine types ─────────────────────────────────────────────────────────

export type ConditionOperator =
  | 'exists' | 'notExists' | 'equals' | 'notEquals'
  | 'in' | 'notIn' | 'contains' | 'notContains'
  | 'startsWith' | 'endsWith' | 'matches';

// id and join are optional to allow lightweight construction; they are always
// present when stored in Rule.conditions.
export interface Condition {
  id?: string;
  join?: 'and' | 'or';
  field: string;
  operator: ConditionOperator;
  value?: string;
  values?: string[];
}

export interface ConditionGroup {
  id: string;
  join?: 'and' | 'or';
  conditions: Condition[];
}

export interface RuleScope {
  level: 'managementGroup' | 'subscription' | 'resourceGroup' | 'resource';
  subscriptions?: string[];
  managementGroups?: string[];
}

// Same concept as Azure Policy's policyType (BuiltIn/Custom) — gates edit/delete permissions.
// 'pack' (below) is the sub-classification within 'builtin' (e.g. rulebeat-core, aprl-v2) and
// is what should grow over time, not this enum.
export type RuleType = 'builtin' | 'community' | 'custom';

// What system a rule's detection logic queries against. Determines which storage shape a rule
// uses and how runCategoryScan() dispatches it — see RULE-MODEL-PROGRAM.md and spec 029.
export type QueryBackend = 'resource-graph' | 'microsoft-graph' | 'log-analytics';

// 'detect' matches Azure Policy's audit semantics — every row a rule's query returns is a
// violation. 'assert' (spec 031) additionally declares a population via Rule.appliesTo, so
// findings can be reported against a known denominator ("5 of 40 affected"). Always derived from
// appliesTo presence at write time (deriveShape() in packages/web/lib/rules.ts) — never an
// independent author-set control, same discipline as RuleKind below.
export type RuleShape = 'detect' | 'assert';

// Derived from queryBackend, never independently authored — see deriveKind() in
// packages/web/lib/rules.ts. 'state' rules check a point-in-time condition; 'activity' rules
// check something that happened over a time window (only log-analytics rules are 'activity').
export type RuleKind = 'state' | 'activity';

// ── Microsoft Graph rule queries (spec 032) ───────────────────────────────────

// The allowlist IS the security boundary, not a UX convenience: Azure's Reader-role scoping
// constrains queryARG, but Graph's `.default` permission scope does not work the same way (see
// graphGet's doc comment on TenantContext) — an ARG-style free-text path would let any rules:write
// editor pull arbitrary Graph data (e.g. /users) with no bound. Enforced server-side in the rules
// API routes, not just the picker UI — see spec 032 "What was considered and rejected."
export type GraphResourcePath =
  | 'users' | 'groups' | 'applications' | 'servicePrincipals'
  | 'directoryRoles' | 'devices' | 'administrativeUnits';

// Runtime companion to the type above — the one array both server-side validation (the rules API
// routes) and the client-side path picker (graph-rule-editor.tsx) read, via the client-safe
// '@rulebeat/core/kql' subpath, so the two can never list a different set of paths.
export const GRAPH_RESOURCE_PATHS: GraphResourcePath[] = [
  'users', 'groups', 'applications', 'servicePrincipals', 'directoryRoles', 'devices', 'administrativeUnits',
];

// One threshold band for computing a per-item severity from a date field inside an expanded array
// (spec 032 Decision 1) — e.g. a credential expiring within 7 days is 'critical', 14 is 'high', 30
// is 'medium'. Bands are evaluated in array order; the first band whose maxDays the item's
// remaining-days falls under wins, mirroring identity-scan.ts's severityForDays() shape exactly.
export interface GraphSeverityBand {
  maxDays: number;
  severity: Severity;
}

// Expands one Graph object into N findings, one per item in `arrayField` (e.g. an application's
// passwordCredentials), each with its own severity computed from `dateField` (e.g. endDateTime)
// against `bands`. Deliberately narrow — date-threshold bands only, not a general expression
// language, since there is exactly one real precedent to generalize from (see spec 032 Risk #1).
// A rule with no `expand` behaves like every other rule: one Graph object is one finding.
export interface GraphExpandConfig {
  arrayField: string;
  dateField: string;
  bands: GraphSeverityBand[];
  /** Field on each expanded item that uniquely identifies it within its parent's array (e.g.
   *  'keyId') — used to build a stable per-item resourceId, the same role a resource's own `id`
   *  plays for a plain (non-expand) finding. */
  itemIdField: string;
  /** Explicit per-rule resourceType for an expanded item's findings (e.g.
   *  'microsoft.aad/applications/secrets') — there is no ARM-style type to derive this from, so it
   *  is author-set rather than computed, same as every other GraphExpandConfig field. */
  resourceType: string;
}

// A Graph-backed rule's detection logic (spec 032): a fixed resource path from the allowlist above
// plus an optional OData $filter and an optional per-item expansion. The Graph-backend counterpart
// to rawKql/visualQuery — Rule.graphQuery, consumed by runGraphRules() only, never runner.ts.
export interface GraphQuery {
  path: GraphResourcePath;
  filter?: string;
  expand?: GraphExpandConfig;
}

// ── Log Analytics rule queries (spec 036) ─────────────────────────────────────

// A Log Analytics-backed rule's detection logic: raw KQL run against the single tenant-wide
// workspace configured in Settings (spec 035) — there is no per-rule workspace selection.
// timeWindowDays is display/validation metadata only, never mechanically appended to the query
// text — the rule's own KQL `where`/`TimeGenerated` filter is the real scoping mechanism, same as
// every other backend scopes itself. The Log Analytics-backend counterpart to rawKql/graphQuery —
// Rule.logsQuery, consumed by runLawRules() only, never runner.ts or graph-runner.ts.
export interface LogAnalyticsQuery {
  kql: string;
  /** Outer bound on how far back this rule's query is expected to look, 1..730 (two years — a
   *  reasonable outer bound on LAW retention rather than an arbitrary guess). Shown in the editor
   *  and validated at save time; has no mechanical effect on the query Azure actually runs. */
  timeWindowDays: number;
  /** Optional field on each result row that identifies a distinct occurrence (e.g. a principal, an
   *  IP) — mirrors GraphExpandConfig.itemIdField's role. Unset collapses every row from a scan onto
   *  one finding (dimensionKey: ''), since there is then no way to tell occurrences apart. */
  dimensionKeyField?: string;
}

// Rule is the core evaluation unit — a named detection check that emits Findings.
// Renamed from 'Policy' to align with the product name (RuleBeat) and avoid
// semantic collision with Azure Policy (the enforcement product we differentiate from).
export interface Rule {
  id: string;
  name: string;
  description: string;
  category: ModuleCategory;
  severity: Severity;
  enabled: boolean;
  type: RuleType;
  pack?: string;
  queryBackend?: QueryBackend; // absent = 'resource-graph' (the SQL-layer default)
  shape?: RuleShape;           // absent = 'detect' (the SQL-layer default)
  kind?: RuleKind;             // absent = 'state' (the SQL-layer default); always derived, never author-set
  group?: string;          // legacy single group; superseded by tags
  tags?: string[];         // multi-dimensional labels (mcsb:*, svc:*, framework:*, waf:*, custom)
  scope: RuleScope;
  resourceTypes: string[];
  conditions: Condition[];
  conditionGroups?: ConditionGroup[];
  projectColumns?: string[];
  remediationSteps?: RemediationStep[];
  rawKql?: string;
  visualQuery?: VisualQuery;
  /** Optional population query (spec 031): when set, a scan also counts how many resources this
   *  rule's scope/type/appliesTo filter matches, independent of how many violate it. Same
   *  VisualQuery shape as visualQuery, compiled with buildPopulationQuery() instead of
   *  buildQueryFromVisual(). Presence of this field is what makes shape 'assert' rather than
   *  'detect' — see deriveShape() in packages/web/lib/rules.ts. */
  appliesTo?: VisualQuery;
  /** Graph-backend counterpart to rawKql/visualQuery (spec 032) — set only when queryBackend is
   *  'microsoft-graph'. Consumed by runGraphRules(), never runner.ts. */
  graphQuery?: GraphQuery;
  /** Log Analytics-backend counterpart to rawKql/graphQuery (spec 036) — set only when
   *  queryBackend is 'log-analytics'. Consumed by runLawRules(), never runner.ts/graph-runner.ts. */
  logsQuery?: LogAnalyticsQuery;
  /** This rule's outcome the last time a scan actually ran it — absent means never run. Zero
   *  findings only counts as passing when this is 'success' (spec 030). */
  lastRunStatus?: RuleExecutionStatus;
  lastRunAt?: string;
  /** Population size from the last scan whose Applies-to query actually returned one (spec 031) —
   *  persisted the same way as lastRunStatus, since the Rules tab renders from stored rule rows,
   *  not a live scan. Absent for every 'detect'-shape rule, and left stale (not cleared) by a scan
   *  whose population query failed, same as lastRunStatus is left untouched for rules outside a
   *  scan's scope. */
  lastPopulationCount?: number;
}

// ── Per-rule execution outcome ────────────────────────────────────────────────
// 'success' may resolve a previously-active finding that didn't reappear. 'failed' (the query
// threw), 'capped' (a top-level take/top, or an ARG-truncated result), and 'invalid' (the query
// ran fine but returned one or more rows with no usable resource id) are all "real but not
// proven complete" and must never resolve prior findings — only their difference in *why* the
// result set can't be trusted as exhaustive. 'invalid' takes precedence over 'capped' when both
// apply to the same rule, since a bad identity is the more actionable problem to surface.
export type RuleExecutionStatus = 'success' | 'failed' | 'capped' | 'invalid';

export interface RuleExecutionOutcome {
  ruleId: string;
  status: RuleExecutionStatus;
  findingCount: number;
  /** Population size from Rule.appliesTo's count query — absent for a 'detect'-shape rule (no
   *  appliesTo declared). Independent of findingCount: a rule can have a known population and
   *  zero findings (fully compliant), or a failed/capped population query alongside a perfectly
   *  successful violation query (see the worst-of-two status combination in runner.ts). */
  populationCount?: number;
}

// runRules() yields both findings and per-rule outcomes on one iteration pass rather than
// buffering outcomes separately — a discriminated union keeps that to a single generator.
export type RuleRunEvent<TFinding> =
  | { kind: 'finding'; finding: TFinding }
  | { kind: 'outcome'; outcome: RuleExecutionOutcome };
