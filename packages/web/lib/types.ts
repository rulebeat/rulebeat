import type { DateWindow } from './date-window';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type RemediationStepType = 'az-cli' | 'powershell' | 'portal' | 'terraform' | 'bicep';
// Categories are DB-defined and user-extensible; the slugs below are seed constants only.
export type ModuleCategory = string;

export interface RemediationStep {
  type: RemediationStepType;
  title: string;
  content: string;
}

export interface Finding {
  module: string;
  ruleId: string;
  fingerprint: string;
  severity: Severity;
  category: ModuleCategory;
  /** 'state' (default, absent means 'state') is a resource in a wrong configuration — has
   *  resourceId/Type/Name below. 'activity' (spec 034) is an occurrence with no resource to point
   *  at; resourceId/Type/Name are absent and `dimensionKey` carries what makes it distinct instead. */
  kind?: 'state' | 'activity';
  /** Human-readable identity of an 'activity' occurrence's pattern. Absent for 'state' findings. */
  dimensionKey?: string;
  // Resource — absent for kind: 'activity' findings, which have no resource to describe.
  resourceId?: string;
  resourceType?: string;
  resourceName?: string;
  subscriptionId: string;
  resourceGroup?: string;
  location?: string;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  recommendation: string;
  remediationSteps: RemediationStep[];
  estimatedMonthlyCost?: number;
  azurePortalLink?: string;
  detectedAt: string;
}

/** A rule that did not run to a trustworthy completion this scan — its prior findings were left
 *  untouched (not resolved) rather than treated as fixed. */
export interface IncompleteRule {
  ruleId: string;
  ruleName: string;
  status: 'failed' | 'capped' | 'invalid';
}

export interface ScanSummary {
  id?: string;
  module: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  subscriptionsScanned: string[];
  findings: Finding[];
  counts: Record<Severity, number>;
  totalRules: number; // enabled rules that ran; 0 for non-rule scans (identity)
  triggeredBy?: 'manual' | 'schedule';
  /** 'partial' when one or more rules failed or returned a capped/truncated result this scan —
   *  those rules' prior findings were preserved rather than resolved. Older scan rows have no
   *  stored value and read back as 'complete'. */
  coverage: 'complete' | 'partial';
  incompleteRules: IncompleteRule[];
}

/** Scan history row metadata without the findings blob — for history lists that don't need to
 *  deserialize every scan's full finding array (snapshot/compare views load the blob on demand). */
export interface ScanMeta {
  id: string;
  module: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  subscriptionsScanned: string[];
  counts: Record<Severity, number>;
  totalRules: number;
  triggeredBy?: 'manual' | 'schedule';
  coverage: 'complete' | 'partial';
  incompleteRules: IncompleteRule[];
}

export interface Suppression {
  id: string;
  fingerprint: string;
  /** Absent when suppressing an 'activity' finding pattern (spec 034), which has no resource. */
  resourceId?: string;
  reason: string;
  suppressedAt: string;
  expiresAt?: string;
}

// ── Visual Query Builder types (mirrored from @rulebeat/core) ────────────────

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
  // Parser-only, never offered in the operator dropdown — KQL the builder has no operator for,
  // carried through verbatim in `rawExpr`. Must stay in step with the same union in
  // packages/core/src/engine/types.ts.
  | 'raw';

export interface VisualFilterCondition {
  id: string;
  join?: 'and' | 'or';
  field: string;
  operator: VisualFilterOperator;
  value?: string;
  value2?: string;
  values?: string[];
  rawExpr?: string;
}

export interface VisualFilterGroup {
  id: string;
  join?: 'and' | 'or';
  conditions: VisualFilterCondition[];
}

export interface FilterStage {
  id: string; type: 'filter'; label?: string; groups: VisualFilterGroup[];
}

export interface ComputedColumn {
  id: string; alias: string; exprType: 'field' | 'function' | 'raw';
  field?: string; fnName?: string; fnArgs?: string[]; rawExpr?: string;
}
export interface ComputeStage { id: string; type: 'compute'; columns: ComputedColumn[]; }

export interface ExpandStage { id: string; type: 'expand'; field: string; alias?: string; }

export type AggFn = 'count' | 'countif' | 'sum' | 'avg' | 'min' | 'max' | 'dcount' | 'make_list' | 'make_set' | 'any';
export interface AggregateColumn { id: string; alias: string; fn: AggFn; field?: string; condition?: string; }
export interface AggregateStage { id: string; type: 'aggregate'; columns: AggregateColumn[]; groupBy: string[]; }

export type JoinKind = 'inner' | 'leftouter' | 'rightouter' | 'fullouter' | 'leftsemi' | 'leftanti' | 'rightsemi' | 'rightanti';
export interface JoinStage { id: string; type: 'join'; kind: JoinKind; rightQuery: string; onLeft: string; onRight: string; }

export interface SortColumn { field: string; direction: 'asc' | 'desc'; }
export interface SortStage { id: string; type: 'sort'; columns: SortColumn[]; }
export interface LimitStage { id: string; type: 'limit'; mode: 'take' | 'top'; count: number; orderBy?: SortColumn; }
export interface ShapeStage { id: string; type: 'shape'; mode: 'project' | 'project-away'; columns: string[]; }

// Parser-only, never offered in the "Add stage" menu — currently only produced for `| union (...)`.
export interface RawStage { id: string; type: 'raw'; clause: string; }

export type QueryStage = FilterStage | ComputeStage | ExpandStage | AggregateStage | JoinStage | SortStage | LimitStage | ShapeStage | RawStage;

export interface VisualQuery { stages: QueryStage[]; }

// ── Dashboard / Widget types ──────────────────────────────────────────────────

export type WidgetType =
  | 'stat-card'
  | 'posture-ring'
  | 'trend'
  | 'top-rules'
  | 'category-scorecard'
  | 'recent-findings'
  | 'severity-breakdown'
  | 'subscription-scorecard'
  | 'top-resources'
  | 'coverage-freshness'
  | 'new-vs-fixed'
  | 'activity-occurrences';

export type StatMetric =
  | 'posture-pct'
  | 'total-findings'
  | 'critical-findings'
  | 'high-findings'
  | 'rules-scanned'
  | 'modules-healthy'
  | 'new-findings'
  | 'fixed-findings';

export interface WidgetDef {
  id: string;
  type: WidgetType;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  config: Record<string, unknown>;
}

export interface DashboardConfig {
  autoRefresh?: number; // seconds, 0 = off
  widgets: WidgetDef[];
  /** @deprecated legacy pre-custom-range field, read as a fallback when `dateWindow` is absent */
  windowDays?: 1 | 7 | 30;
  dateWindow?: DateWindow; // dashboard-level filter bar window; default { mode: 'relative', days: 7 } when absent
  /** Dashboard-level filter bar state. */
  filters?: {
    categories?: string[];
    subscriptions?: string[];
    resourceGroups?: string[];
    tags?: string[];
    severities?: Severity[];
    ruleIds?: string[];
  };
}

export interface Dashboard {
  id: string;
  name: string;
  description?: string;
  config: DashboardConfig;
  isDefault: boolean;
  createdAt: string;
}

export interface Category {
  id: string;         // slug, e.g. 'compliance'
  label: string;
  color?: string;
  icon?: string;
  sortOrder: number;
  isBuiltin: boolean;
  createdAt: string;
}

/** `/api/widgets/filter-options` response shape — shared by the dashboard filter bar and every
 *  widget's own "Scope" override config panel, both of which fetch that endpoint. */
export interface FilterOptionsResponse {
  categories: Category[];
  tags: string[];
  subscriptions: string[];
  resourceGroups: string[];
  rules: Array<{ id: string; name: string }>;
}

// ── Rule engine types ─────────────────────────────────────────────────────────

export type ConditionOperator =
  | 'exists'
  | 'notExists'
  | 'equals'
  | 'notEquals'
  | 'in'
  | 'notIn'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'matches';

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

// What system a rule's detection logic queries against — see RULE-MODEL-PROGRAM.md and spec 029.
export type QueryBackend = 'resource-graph' | 'microsoft-graph' | 'log-analytics';

// 'assert' when appliesTo is set (spec 031), else 'detect'. Always derived, never author-set.
export type RuleShape = 'detect' | 'assert';

// Derived from queryBackend, never independently authored.
export type RuleKind = 'state' | 'activity';

// Microsoft Graph query definition (spec 032) — set only when queryBackend = 'microsoft-graph'.
// Mirrored from @rulebeat/core's engine/types.ts; keep the two in step.
export type GraphResourcePath =
  | 'users' | 'groups' | 'applications' | 'servicePrincipals'
  | 'directoryRoles' | 'devices' | 'administrativeUnits';

export interface GraphSeverityBand {
  maxDays: number;
  severity: Severity;
}

export interface GraphExpandConfig {
  arrayField: string;
  dateField: string;
  bands: GraphSeverityBand[];
  itemIdField: string;
  resourceType: string;
}

export interface GraphQuery {
  path: GraphResourcePath;
  filter?: string;
  expand?: GraphExpandConfig;
}

// Log Analytics query definition (spec 036) — set only when queryBackend = 'log-analytics'.
// Mirrored from @rulebeat/core's engine/types.ts; keep the two in step.
export interface LogAnalyticsQuery {
  kql: string;
  timeWindowDays: number;
  dimensionKeyField?: string;
}

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
  /** @deprecated Superseded by `tags` (multi-value). Kept for read compat with old rows. */
  group?: string;
  tags?: string[];
  scope: RuleScope;
  resourceTypes: string[];
  conditions: Condition[];
  conditionGroups?: ConditionGroup[];
  projectColumns?: string[];
  remediationSteps?: RemediationStep[];
  rawKql?: string;
  visualQuery?: VisualQuery;
  /** Population/count query (spec 031) — presence makes `shape` 'assert' rather than 'detect'.
   *  Absent (the default) means this rule is measured against every resource in scope. */
  appliesTo?: VisualQuery;
  /** Microsoft Graph query definition (spec 032) — set only when queryBackend = 'microsoft-graph'. */
  graphQuery?: GraphQuery;
  /** Log Analytics query definition (spec 036) — set only when queryBackend = 'log-analytics'. */
  logsQuery?: LogAnalyticsQuery;
  /** This rule's outcome the last time a scan actually ran it — absent means never run. Zero
   *  findings only counts as passing when this is 'success' (spec 030). */
  lastRunStatus?: 'success' | 'failed' | 'capped' | 'invalid';
  lastRunAt?: string;
  /** Population size from the last scan whose Applies-to query actually returned one (spec 031).
   *  Absent for every 'detect'-shape rule, and left stale (not cleared) by a scan whose population
   *  query failed. */
  lastPopulationCount?: number;
}

// ── Live query page types (spec 037) ──────────────────────────────────────────

export type QueryVisibility = 'private' | 'shared';

/** A query composed on the /query page that a user chose to keep. 'private' is visible only to its
 *  owner and is deleted alongside them; 'shared' is visible to every editor/admin and survives its
 *  owner's deletion — `ownerEmail` stays denormalized for display once that happens. */
export interface SavedQuery {
  id: string;
  name: string;
  queryBackend: QueryBackend;
  /** resource-graph only. */
  scope?: RuleScope;
  visualQuery?: VisualQuery;
  rawKql?: string;
  graphQuery?: GraphQuery;
  logsQuery?: LogAnalyticsQuery;
  visibility: QueryVisibility;
  ownerId: string;
  ownerEmail: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
}

/** A recorded run from the live query page (spec 037 follow-up). Always the caller's own — there is no shared visibility. */
export interface QueryRun {
  id: string;
  queryBackend: QueryBackend;
  /** resource-graph only. */
  scope?: RuleScope;
  rawKql?: string;
  graphQuery?: GraphQuery;
  logsQuery?: LogAnalyticsQuery;
  count: number;
  capped: boolean;
  truncated: boolean;
  savedQueryId?: string;
  ranAt: string;
}
