import type { Rule } from '@rulebeat/core';
import { DEMO_SUBSCRIPTIONS } from '../../lib/demo-fixtures';
import { fakeTenantContext, type FakeTenantContext } from '../../tests/helpers/fake-azure';
import { rand01 } from './prng';
import type { Estate, EstateResource } from './estate';
import { graphAppsForDay, type SyntheticApp } from './identity-fixtures';
import type { RuleFixture } from './rule-fixture';
import { rowsForRuleOnDay } from './violation-engine';

// Built on the same `fakeTenantContext()` the unit test suite uses (tests/helpers/fake-azure.ts),
// not a bespoke context shape — anything wired correctly for the test suite is already proven
// compatible with runRules()/runGraphRules(), and its `.logs` array is how a per-rule query
// failure that either engine reports as an outcome (rather than throwing) gets surfaced (see
// assertNoQueryFailures).
const DEMO_TENANT_ID = '11111111-2222-3333-4444-555555555555';

/** Fraction of enabled rules that get zero candidates for their whole run, i.e. never produce a
 *  finding on any resource, on any simulated day. Without this, every rule ends up with at least
 *  one violator somewhere across 510 resources purely from `violation-engine.ts`'s per-resource
 *  selection odds (the chance of a rule landing zero violators across hundreds of independent
 *  rolls is negligible), which makes the tenant-wide "Overall Posture" stat — a rule only
 *  counts as passing if it has *no* active finding anywhere — pin at 0% regardless of how healthy
 *  the estate otherwise looks. Deciding cleanliness per rule (not per resource) is what actually
 *  produces a "well-run-but-imperfect" posture percentage instead of a flat zero. */
const CLEAN_RULE_RATE = 0.6;

function candidatesFor(fixture: RuleFixture, estate: Estate): EstateResource[] {
  if (rand01(`clean-rule::${fixture.ruleId}`) < CLEAN_RULE_RATE) return [];
  if (fixture.resourceTypes.length === 0) return estate.resources;
  const types = new Set(fixture.resourceTypes);
  return estate.resources.filter(r => types.has(r.type));
}

// Matches the one identity-enrichment query shape runner.ts ever issues (packages/core/src/engine
// /runner.ts) — a fixed `resources | where id in (...) | project id, type, location,
// resourceGroup, subscriptionId` follow-up for rows missing any of those four columns.
const ENRICHMENT_RE =
  /^resources\s*\n\|\s*where id in \(([\s\S]*?)\)\s*\n\|\s*project id, type, location, resourceGroup, subscriptionId$/i;

function handleEnrichmentQuery(kql: string, estate: Estate): Record<string, unknown>[] | null {
  const match = kql.match(ENRICHMENT_RE);
  if (!match) return null;

  return match[1]
    .split(',')
    .map(part => part.trim().replace(/^'/, '').replace(/'$/, '').replace(/''/g, "'"))
    .map(id => estate.byId.get(id))
    .filter((r): r is EstateResource => !!r)
    .map(r => ({ id: r.id, type: r.type, location: r.location, resourceGroup: r.resourceGroup, subscriptionId: r.subscriptionId }));
}

export interface CreateFakeContextOptions {
  estate: Estate;
  rules: Rule[];
  fixturesByRuleId: Map<string, RuleFixture>;
  identityApps: SyntheticApp[];
  day: number;
  totalDays: number;
}

/** One fresh context per simulated day — cheap (a handful of closures), and it means `.logs` only
 *  ever holds that day's activity, so `assertNoQueryFailures` doesn't need to track a read offset. */
export function createFakeContext(opts: CreateFakeContextOptions): FakeTenantContext {
  const { estate, rules, fixturesByRuleId, identityApps, day, totalDays } = opts;

  const queryIndex = new Map<string, RuleFixture>();
  for (const rule of rules) {
    if (!rule.rawKql) continue;
    const fixture = fixturesByRuleId.get(rule.id);
    if (fixture) queryIndex.set(rule.rawKql.trim(), fixture);
  }

  return fakeTenantContext({
    tenantId: DEMO_TENANT_ID,
    subscriptionIds: DEMO_SUBSCRIPTIONS.map(s => s.id),
    rows: kql => {
      const trimmed = kql.trim();
      const fixture = queryIndex.get(trimmed);
      if (fixture) return rowsForRuleOnDay(fixture, candidatesFor(fixture, estate), day, totalDays);

      const enrichment = handleEnrichmentQuery(trimmed, estate);
      if (enrichment) return enrichment;

      // Every enabled rule is enabled *because* it has a fixture (see replay.ts) — reaching here
      // means a fixture's stored rawKql no longer matches the seeded rule's actual rawKql, which
      // would otherwise silently render as "this rule found nothing" instead of a build error.
      throw new Error(`Demo generator: no fixture matched this rule's KQL exactly:\n${kql}`);
    },
    graphRows: path => {
      if (path.startsWith('/applications')) return graphAppsForDay(identityApps, day, totalDays);
      throw new Error(`Demo generator: unrecognized Graph path: ${path}`);
    },
  });
}

/** `runRules()` catches and logs a per-rule query failure rather than throwing (so one bad rule
 *  doesn't abort a real scan) — call this after each simulated day's run so the same failure aborts
 *  *generation*, where silence would otherwise just make one category quietly sparse. */
export function assertNoQueryFailures(ctx: FakeTenantContext, day: number): void {
  const failures = ctx.logs.filter(l => l.includes('query failed') || l.includes('Graph access failed'));
  if (failures.length > 0) {
    throw new Error(`Demo generator: query failure(s) on simulated day ${day}:\n${failures.join('\n')}`);
  }
}
