// Single source of truth for KQL generation and parsing.
// ALL logic lives in packages/core/src/engine/kql.ts.
// DO NOT add any KQL logic here — update core and rebuild.
export {
  buildQueryFromVisual,
  conditionToKql,
  parseKqlToVisualQuery,
  hasCompilableFilter,
  DEFAULT_PROJECT_COLUMNS,
  GRAPH_RESOURCE_PATHS,
} from '@rulebeat/core/kql';

export type {
  ParsedVisualResult,
  AggFn, AggregateColumn, AggregateStage,
  Condition, ConditionOperator,
  ComputedColumn, ComputeStage,
  ExpandStage,
  FilterStage,
  JoinKind, JoinStage,
  LimitStage,
  QueryStage,
  RawStage,
  ShapeStage,
  SortColumn, SortStage,
  VisualFilterCondition, VisualFilterGroup, VisualFilterOperator,
  VisualQuery,
} from '@rulebeat/core/kql';
