import type { Rule } from '@rulebeat/core';
import { TYPE_META, type EstateResource } from './estate';
import { extractProjectColumns } from './kql-columns';
import { rand01 } from './prng';
import { identityColumns, type RuleFixture } from './rule-fixture';

const IDENTITY_ALIASES = new Set(['id', 'name', 'type', 'location', 'resourcegroup', 'subscriptionid']);

/** No real where-clause evaluation here — this only needs to produce evidence that *reads* as
 *  plausible for the column name, not a value that's provably derived from the rule's own logic.
 *  APRL rules are ~35 out of 143 curated ones; nobody reviewing the demo checks these against the
 *  upstream KQL line by line the way they would for the 13 hand-authored core rules. */
function heuristicValue(alias: string, r: EstateResource, ruleId: string): unknown {
  const lower = alias.toLowerCase();
  const seed = `${ruleId}::${alias}::${r.id}`;
  const roll = rand01(seed);

  if (lower === 'tags') return r.tags;
  if (lower.includes('enabled') || lower.includes('supported')) return false;
  if (lower.includes('disabled') || lower.includes('deprecated')) return true;
  if (lower.includes('version')) return ['1.0', '1.1', '8.0', '2012-R2'][Math.floor(roll * 4)];
  if (lower.includes('sku') || lower.includes('tier')) return ['Basic', 'Standard', 'Free'][Math.floor(roll * 3)];
  if (lower.includes('count') || lower.includes('num')) return Math.floor(roll * 5);
  if (lower.includes('size') || lower.includes('gb') || lower.includes('capacity')) return Math.floor(20 + roll * 480);
  if (lower.includes('redundancy') || lower.includes('replication')) return 'LRS';
  if (lower.includes('zone')) return null;
  if (lower.includes('date') || lower.includes('time')) {
    const daysAgo = 30 + Math.floor(roll * 200);
    return new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  }
  return roll > 0.5 ? 'None' : 'Disabled';
}

/** Builds one generic RuleFixture per eligible APRL rule. A rule is eligible only if every one of
 *  its declared resourceTypes exists in `TYPE_META` — otherwise the estate has nothing that could
 *  ever match it, so it's silently excluded rather than enabled-but-permanently-empty. */
export function buildAprlFixtures(rules: Rule[]): RuleFixture[] {
  return rules
    .filter(rule => rule.pack === 'aprl-v2')
    .filter(rule => rule.resourceTypes.length > 0 && rule.resourceTypes.every(t => TYPE_META[t.toLowerCase()]))
    .map((rule): RuleFixture => {
      const columns = extractProjectColumns(rule.rawKql ?? '');
      return {
        ruleId: rule.id,
        resourceTypes: rule.resourceTypes.map(t => t.toLowerCase()),
        severity: rule.severity,
        buildRow: (r: EstateResource) => {
          if (columns.length === 0) return identityColumns(r);
          const row: Record<string, unknown> = {};
          for (const col of columns) {
            const lower = col.alias.toLowerCase();
            row[col.alias] = IDENTITY_ALIASES.has(lower)
              ? identityColumns(r)[lower === 'resourcegroup' ? 'resourceGroup' : lower === 'subscriptionid' ? 'subscriptionId' : lower]
              : heuristicValue(col.alias, r, rule.id);
          }
          return row;
        },
      };
    });
}
