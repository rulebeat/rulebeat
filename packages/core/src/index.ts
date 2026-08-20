export type {
  Finding,
  // Part of TenantContext.log's second parameter, so callers implementing or wrapping a context
  // (including the test suite's fake Azure layer and the production server logger) need it by name.
  LogFields,
  ModuleCategory,
  // Part of TenantContext.queryARG's signature, so callers implementing or wrapping a context
  // (including the test suite's fake Azure layer) need it by name.
  QueryScope,
  RemediationStep,
  RemediationStepType,
  ScanSummary,
  Severity,
  TenantContext,
} from './types.js';

export { createFinding, computeFingerprint, createActivityFinding, computeActivityFingerprint } from './finding.js';
export { extractAzureErrorMessage } from './errors.js';
export { buildTenantContext, listAccessibleSubscriptions, GraphTruncatedError, GRAPH_MAX_ROWS } from './auth/index.js';
export {
  fetchWithRetry,
  AZURE_CALL_TIMEOUT_MS,
  AZURE_LIST_TIMEOUT_MS,
} from './net/fetch-retry.js';
export type { FetchRetryOptions } from './net/fetch-retry.js';
export { ResourceGraphClient, ResourceGraphTruncatedError } from './clients/resource-graph.js';
export {
  queryLogAnalyticsWorkspace,
  rowsFromLogsTable,
  LogAnalyticsTruncatedError,
  LogAnalyticsNotConfiguredError,
} from './clients/log-analytics.js';
export { getAllResourceTypes, getResourceTypeFields } from './clients/resource-schema.js';
export type {
  AggFn, AggregateColumn, AggregateStage,
  Condition, ConditionGroup, ConditionOperator,
  ComputedColumn, ComputeStage,
  ExpandStage,
  FilterStage,
  GraphExpandConfig, GraphQuery, GraphResourcePath, GraphSeverityBand,
  JoinKind, JoinStage,
  LimitStage,
  LogAnalyticsQuery,
  QueryBackend,
  Rule, RuleExecutionOutcome, RuleExecutionStatus, RuleRunEvent, RuleKind, RuleScope, RuleShape, RuleType,
  QueryStage,
  ShapeStage,
  SortColumn, SortStage,
  VisualFilterCondition, VisualFilterGroup, VisualFilterOperator,
  VisualQuery,
} from './engine/index.js';
export type { ParsedVisualResult } from './engine/index.js';
export {
  buildRuleQuery,
  buildQueryFromVisual, conditionToKql,
  parseKqlToVisualQuery,
  queryHasTopLevelLimit,
  runRules,
  runGraphRules,
  buildGraphPath,
  runLawRules,
  GRAPH_RESOURCE_PATHS,
} from './engine/index.js';
