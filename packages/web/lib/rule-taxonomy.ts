import type { Rule } from './types';

/**
 * Resource (queryBackend: 'resource-graph'), Directory (queryBackend: 'microsoft-graph', spec 032),
 * and Log Analytics (queryBackend: 'log-analytics', spec 036) configuration are all authorable now.
 * Shared by rule-detail-client.tsx (hides the Duplicate button) and rules/new/page.tsx (falls
 * back to a blank new-rule form for a `?copyFrom=` of an un-authorable rule) so the two never drift
 * apart. Client-safe: no server-only imports, so both a client component and a server component can
 * call it.
 */
export function canDuplicateRule(rule: Pick<Rule, 'queryBackend'>): boolean {
  const backend = rule.queryBackend ?? 'resource-graph';
  return backend === 'resource-graph' || backend === 'microsoft-graph' || backend === 'log-analytics';
}
