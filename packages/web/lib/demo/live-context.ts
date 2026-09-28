import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Rule } from '@rulebeat/core';
import { BUILTIN_RULES } from '../builtin-rules';
import { DATA_DIR } from '../db/sqlite-path';
import { buildAprlFixtures } from './aprl-fixtures';
import { resolveDemoConfig } from './config';
import { CORE_FIXTURES } from './core-fixtures';
import { buildEstate, type Estate } from './estate';
import { createFakeContext } from './fake-context';
import type { FakeTenantContext } from './fake-tenant';
import { buildIdentityApps, type SyntheticApp } from './identity-fixtures';
import { setGeneratorSeed } from './prng';
import { TOTAL_DAYS } from './replay';
import type { RuleFixture } from './rule-fixture';
import { DEMO_UNANSWERED_RULE_REASON, type CountsUnansweredQueries } from './unanswered';

/** A query the Demo's synthetic tenant has no data for. */
export class DemoQueryUnansweredError extends Error {
  constructor(detail: string) {
    super(`${DEMO_UNANSWERED_RULE_REASON} (${detail.split('\n')[0]})`);
    this.name = 'DemoQueryUnansweredError';
  }
}

/** The tenant a Run now in a Demo scans: the generator's synthetic estate on its last day. */
export type LiveDemoContext = FakeTenantContext & CountsUnansweredQueries;

interface DemoWorld {
  estate: Estate;
  identityApps: SyntheticApp[];
  shippedRules: Rule[];
  fixturesByRuleId: Map<string, RuleFixture>;
}

let world: DemoWorld | undefined;

/** The rules this release ships, as shipped: the built-ins plus every committed pack. Keyed on
 *  their own KQL, so a Visitor's edit to a rule is a different query the Demo has no data for. */
function loadShippedRules(packsDir: string): Rule[] {
  const rules: Rule[] = [...BUILTIN_RULES];
  if (!existsSync(packsDir)) return rules;
  for (const file of readdirSync(packsDir).filter(f => f.endsWith('.json') && f !== 'pack-manifest.json')) {
    const pack = JSON.parse(readFileSync(join(packsDir, file), 'utf-8')) as Array<Rule & { rules?: unknown }>;
    rules.push(...pack);
  }
  return rules;
}

function demoWorld(packsDir: string): DemoWorld {
  if (world) return world;
  // Same Seed as the generator, so the estate and the rows are the ones the Demo was built from.
  setGeneratorSeed(resolveDemoConfig().seed);
  const shippedRules = loadShippedRules(packsDir);
  const fixtures = [...CORE_FIXTURES, ...buildAprlFixtures(shippedRules)];
  world = {
    estate: buildEstate(),
    identityApps: buildIdentityApps(),
    shippedRules,
    fixturesByRuleId: new Map(fixtures.map(f => [f.ruleId, f])),
  };
  return world;
}

/**
 * The tenant context for a scan in a running Demo. It answers every rule the Demo ships with the
 * rows its last simulated day produced. Any other query (a new rule, an edited one) fails that rule
 * with DEMO_UNANSWERED_RULE_REASON, and the rest of the scan carries on.
 */
export function createLiveDemoContext(opts: { packsDir?: string } = {}): LiveDemoContext {
  const { estate, identityApps, shippedRules, fixturesByRuleId } = demoWorld(opts.packsDir ?? join(DATA_DIR, 'packs'));
  let unanswered = 0;
  const ctx = createFakeContext({
    estate,
    rules: shippedRules,
    fixturesByRuleId,
    identityApps,
    day: TOTAL_DAYS - 1,
    totalDays: TOTAL_DAYS,
    unknownQuery: what => {
      unanswered += 1;
      return new DemoQueryUnansweredError(what);
    },
  });
  return Object.assign(ctx, { unansweredQueries: () => unanswered });
}

/** Tests only: forget the cached estate, so a test can change the Seed or the packs. */
export function resetLiveDemoContextForTests(): void {
  world = undefined;
}
