// Pure KQL utilities — zero Azure SDK runtime dependencies.
// Safe to import in browser / client components via '@rulebeat/core/kql'.
export {
  buildRuleQuery,
  buildQueryFromVisual,
  conditionToKql,
  parseKqlToVisualQuery,
  hasCompilableFilter,
  DEFAULT_PROJECT_COLUMNS,
} from './engine/kql.js';

export type { ParsedVisualResult } from './engine/kql.js';

export type {
  AggFn, AggregateColumn, AggregateStage,
  Condition, ConditionGroup, ConditionOperator,
  ComputedColumn, ComputeStage,
  ExpandStage,
  FilterStage,
  GraphExpandConfig, GraphQuery, GraphResourcePath, GraphSeverityBand,
  JoinKind, JoinStage,
  LimitStage,
  Rule, RuleScope, RuleType,
  QueryStage,
  RawStage,
  ShapeStage,
  SortColumn, SortStage,
  VisualFilterCondition, VisualFilterGroup, VisualFilterOperator,
  VisualQuery,
} from './engine/types.js';

// Runtime allowlist for the Directory rule path picker (graph-rule-editor.tsx) — re-exported here,
// not just from the main entry point, because it's a client component and this subpath is the only
// one with no Azure SDK/Node dependency chain. See its doc comment in engine/types.ts.
export { GRAPH_RESOURCE_PATHS } from './engine/types.js';
