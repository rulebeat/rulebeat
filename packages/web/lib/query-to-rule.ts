import type { GraphQuery, Rule, RuleScope } from '@/lib/types';
import type { VisualQuery } from '@/lib/kql';

const DEFAULT_CATEGORY = 'compliance';

function parseCsv(text: string): string[] {
  return text.split(',').map(s => s.trim()).filter(Boolean);
}

export type QueryToRuleInput =
  | {
      backend: 'resource-graph';
      defaultCategoryId: string;
      scope?: RuleScope;
      resourceTypesText: string;
      projectColumnsText: string;
      visualQuery: VisualQuery;
      rawKql: string;
    }
  | {
      backend: 'microsoft-graph';
      defaultCategoryId: string;
      graphQuery: GraphQuery;
    }
  | {
      backend: 'log-analytics';
      defaultCategoryId: string;
      logsKql: string;
    };

/**
 * Builds the same Rule shape the /query page's "Save as rule" action hands to /rules/new via
 * sessionStorage (see rule-new-client.tsx's readQueryPrefill()) — pulled out of query-client.tsx
 * so each backend's payload shape is independently testable without rendering the component.
 */
export function buildRuleFromQuery(input: QueryToRuleInput): Rule {
  const base = {
    id: '',
    name: '',
    description: '',
    category: input.defaultCategoryId || DEFAULT_CATEGORY,
    severity: 'medium' as const,
    enabled: false,
    type: 'custom' as const,
    resourceTypes: [] as string[],
    conditions: [],
  };

  if (input.backend === 'resource-graph') {
    return {
      ...base,
      queryBackend: 'resource-graph',
      scope: input.scope ?? { level: 'resource' },
      resourceTypes: parseCsv(input.resourceTypesText),
      visualQuery: input.visualQuery,
      rawKql: input.rawKql,
      projectColumns: parseCsv(input.projectColumnsText),
    };
  }

  if (input.backend === 'microsoft-graph') {
    return {
      ...base,
      queryBackend: 'microsoft-graph',
      scope: { level: 'subscription' },
      graphQuery: input.graphQuery,
    };
  }

  return {
    ...base,
    queryBackend: 'log-analytics',
    scope: { level: 'subscription' },
    logsQuery: { kql: input.logsKql, timeWindowDays: 30 },
  };
}
