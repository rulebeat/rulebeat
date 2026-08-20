import { buildQueryFromVisual, type VisualQuery } from './kql';
import type { RuleScope } from './types';

export interface VisualQueryDriftCheckInput {
  storedVisualQuery: VisualQuery;
  storedRawKql: string;
  scope: RuleScope;
  resourceTypes: string[];
  projectColumns: string[];
}

/**
 * A stored visualQuery can go stale relative to rawKql — e.g. a rule opened and saved before a
 * parser fix shipped, which baked a since-fixed loss (like a dropped union clause) permanently into
 * the blob. Detected by regenerating KQL from the stored visualQuery: if it doesn't reproduce what's
 * actually saved, the blob is stale and a fresh reparse of rawKql is more trustworthy than the stored
 * one. Not union-specific — this protects any future engine change that makes an old stored blob stale.
 */
export function isVisualQueryStale(input: VisualQueryDriftCheckInput): boolean {
  const regenerated = buildQueryFromVisual(input.storedVisualQuery, {
    scope: input.scope,
    resourceTypes: input.resourceTypes,
    projectColumns: input.projectColumns,
  });
  return regenerated !== input.storedRawKql;
}
