/**
 * Builders for the shipped catalogue the seeders take as an input (`runSeeds(..., { catalogue })`),
 * so a test can ship "version 2" of a rule without editing the real rule files.
 */
import type { RuleDefinition, ShippedCatalogue, ShippedRule } from '@/lib/shipped-catalogue';

export function shippedRule(
  overrides: Partial<Omit<ShippedRule, 'definition'>> & { definition?: Partial<RuleDefinition> } = {},
): ShippedRule {
  const { definition, ...rest } = overrides;
  return {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    pack: 'rulebeat-core',
    versionScheme: 'semver',
    version: '1.0.0',
    releaseNote: 'Initial version.',
    enabled: true,
    definition: {
      name: 'Test rule',
      description: 'A test rule.',
      category: 'security',
      severity: 'medium',
      queryBackend: 'resource-graph',
      kind: 'state',
      resourceTypes: ['microsoft.compute/disks'],
      scope: { level: 'resource' },
      conditions: [],
      conditionGroups: null,
      visualQuery: null,
      projectColumns: null,
      rawKql: `Resources | where type =~ 'microsoft.compute/disks' | project id, name, type, location, resourceGroup, subscriptionId`,
      graphQuery: null,
      logsQuery: null,
      ...definition,
    },
    ...rest,
  };
}

/** A catalogue that read every pack cleanly, so retirement is allowed. */
export function catalogueOf(...rules: ShippedRule[]): ShippedCatalogue {
  return { rules, packsDirRead: true, unreadablePacks: [] };
}
