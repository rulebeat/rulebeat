/**
 * WS2g cont. · the demo data generator (scripts/demo/*).
 *
 * These modules run outside the app via `tsx` (see scripts-import-ban.test.ts) and were already
 * proven to work once, end to end, by hand: `npm run generate-demo` produced 510 resources, 886
 * findings across all 5 categories and 60 successful schedule_runs with zero query failures. This
 * suite pins that behaviour so it stays true — the risk isn't the generator's own logic (it's pure
 * functions and one already-tested fake context), it's *drift*: a future edit to builtin-rules.ts
 * or a re-sync of the aprl-v2 pack changing a rule's rawKql out from under a hand-authored or
 * generic fixture, which fake-context.ts's own comment notes would otherwise render as "this rule
 * found nothing" instead of a build error.
 *
 * Runs against the ambient test database tests/setup.ts already points at a throwaway file —
 * nothing here touches demo.db or rulebeat.db.
 */
import { describe, expect, it, vi } from 'vitest';
import { resolve, join } from 'node:path';
import type { Rule } from '@rulebeat/core';
import { runRules } from '@rulebeat/core';
import { loadRules, setRulesEnabled } from '@/lib/rules';
import { db, rawSqlite } from '@/lib/db/client';
import { runSeeds } from '@/lib/db/migrate';
import { scheduleRuns, findings } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { buildEstate, TYPE_META } from '../../scripts/demo/estate';
import { buildIdentityApps, graphAppsForDay } from '../../scripts/demo/identity-fixtures';
import { CORE_FIXTURES, CORE_RULE_IDS } from '../../scripts/demo/core-fixtures';
import { buildAprlFixtures } from '../../scripts/demo/aprl-fixtures';
import { extractProjectColumns } from '../../scripts/demo/kql-columns';
import { isViolatingOnDay, rowsForRuleOnDay } from '../../scripts/demo/violation-engine';
import { createFakeContext, assertNoQueryFailures } from '../../scripts/demo/fake-context';
import { replay } from '../../scripts/demo/replay';
import type { RuleFixture } from '../../scripts/demo/rule-fixture';

async function drain<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

// lib/db/client.ts's own pack-seeding call resolves its data directory from process.cwd(), which
// this repo's own `npm test`/`npm run test:web` invoke from the repo root — a directory with no
// data/packs/ of its own (see pack-defaults.test.ts, which hits the same thing and works around it
// the same way). Re-run runSeeds against the *real*, __dirname-anchored data dir on top of the
// ambient test db so loadRules() below actually returns the committed aprl-v2 pack regardless of
// which directory the test process happened to start in. runSeeds is INSERT OR IGNORE + UPDATE, so
// this is safe to layer on top of whatever tests/setup.ts already seeded.
const REAL_DATA_DIR = join(resolve(__dirname, '..', '..'), 'data');
runSeeds(rawSqlite!, REAL_DATA_DIR, { skipOwnerBootstrap: true });

// ── Determinism ─────────────────────────────────────────────────────────────────────────────────
// Every downstream assertion in this file relies on the generator being a pure function of its
// hardcoded seeds — if it weren't, "run it once, assert fixed counts" (the plan's own stated design)
// would be impossible.

describe('determinism', () => {
  it('buildEstate() produces byte-identical output across calls', () => {
    const a = buildEstate();
    const b = buildEstate();
    expect(a.resources).toEqual(b.resources);
  });

  it('buildIdentityApps() produces byte-identical output across calls', () => {
    const a = buildIdentityApps();
    const b = buildIdentityApps();
    expect(a).toEqual(b);
  });

  it('the estate is non-trivial and spans more than one resource type', () => {
    const estate = buildEstate();
    expect(estate.resources.length).toBeGreaterThan(100);
    const types = new Set(estate.resources.map(r => r.type));
    expect(types.size).toBeGreaterThan(5);
    for (const type of types) expect(TYPE_META[type]).toBeDefined();
  });
});

// ── extractProjectColumns() ─────────────────────────────────────────────────────────────────────
// A standalone parser (deliberately not @rulebeat/core's own, see kql-columns.ts's doc comment) —
// worth testing directly since a wrong split here silently mis-shapes a fixture's fake ARG rows.

describe('extractProjectColumns()', () => {
  it('returns [] when the query has no project clause', () => {
    expect(extractProjectColumns('resources | where type == "x"')).toEqual([]);
  });

  it('bare column names get alias === expr', () => {
    const cols = extractProjectColumns('resources\n| project id, name, tags');
    expect(cols).toEqual([
      { alias: 'id', expr: 'id' },
      { alias: 'name', expr: 'name' },
      { alias: 'tags', expr: 'tags' },
    ]);
  });

  it('splits alias = expr on a single "="', () => {
    const cols = extractProjectColumns("resources\n| project minTls = properties.minimumTlsVersion");
    expect(cols).toEqual([{ alias: 'minTls', expr: 'properties.minimumTlsVersion' }]);
  });

  it('does not mistake "==", "!=", "<=", ">=" for an assignment', () => {
    const cols = extractProjectColumns("resources\n| project isOld = createdDate <= ago(30d)");
    expect(cols).toEqual([{ alias: 'isOld', expr: 'createdDate <= ago(30d)' }]);
  });

  it('does not split a comma nested inside a function call or array literal', () => {
    const cols = extractProjectColumns("resources\n| project tag = strcat('a:', tostring(props[0]))");
    expect(cols).toHaveLength(1);
    expect(cols[0].alias).toBe('tag');
    expect(cols[0].expr).toBe("strcat('a:', tostring(props[0]))");
  });

  it('uses the last | project line when a query has more than one', () => {
    const cols = extractProjectColumns(
      'resources\n| project id, name, extra\n| project id, name',
    );
    expect(cols.map(c => c.alias)).toEqual(['id', 'name']);
  });
});

// ── violation-engine.ts ─────────────────────────────────────────────────────────────────────────

describe('isViolatingOnDay()', () => {
  it('is a pure function of (rule, resource, day) — repeated calls agree', () => {
    const calls = Array.from({ length: 5 }, () =>
      isViolatingOnDay('rule-a', 'high', 'resource-1', 10, 60),
    );
    expect(new Set(calls).size).toBe(1);
  });

  it('different resources under the same rule/day are not all forced the same way', () => {
    const resourceIds = Array.from({ length: 300 }, (_, i) => `resource-${i}`);
    const results = resourceIds.map(id => isViolatingOnDay('rule-a', 'medium', id, 30, 60));
    expect(results.some(v => v)).toBe(true);
    expect(results.some(v => !v)).toBe(true);
  });

  it('selection rate is roughly severity-ordered: critical rarest, low most common', () => {
    const resourceIds = Array.from({ length: 2000 }, (_, i) => `res-${i}`);
    const rateFor = (severity: 'critical' | 'high' | 'medium' | 'low') =>
      resourceIds.filter(id => isViolatingOnDay('rate-check', severity, id, 30, 60)).length / resourceIds.length;

    const critical = rateFor('critical');
    const high = rateFor('high');
    const medium = rateFor('medium');
    const low = rateFor('low');

    expect(critical).toBeLessThan(high);
    expect(high).toBeLessThan(medium);
    expect(medium).toBeLessThan(low);
    // Loose bounds around the documented rates (0.08/0.14/0.22/0.3) — this guards against someone
    // accidentally flattening or inverting the table, not against every possible tuning tweak.
    expect(critical).toBeGreaterThan(0.03);
    expect(critical).toBeLessThan(0.15);
    expect(low).toBeGreaterThan(0.2);
    expect(low).toBeLessThan(0.4);
  });

  it('produces at least one resource whose answer changes between day 0 and the final day', () => {
    // Proves the lifecycle patterns (resolved-partway / new-partway / resolved-reactivated) actually
    // fire, not just the static "steady" case — a demo where nothing ever changes would make the
    // trend/new-vs-fixed dashboard widgets show a flat line.
    const totalDays = 60;
    const resourceIds = Array.from({ length: 500 }, (_, i) => `lifecycle-${i}`);
    const changed = resourceIds.some(id => {
      const first = isViolatingOnDay('lifecycle-rule', 'high', id, 0, totalDays);
      const last = isViolatingOnDay('lifecycle-rule', 'high', id, totalDays - 1, totalDays);
      return first !== last;
    });
    expect(changed).toBe(true);
  });
});

describe('rowsForRuleOnDay()', () => {
  it('only returns rows for candidates isViolatingOnDay selected, shaped by buildRow', () => {
    const estate = buildEstate();
    const candidates = estate.resources.filter(r => r.type === 'microsoft.compute/disks').slice(0, 50);
    const fixture: RuleFixture = CORE_FIXTURES.find(f => f.ruleId === '7a25444f-90c1-4c4e-b6dc-3076a857dfa8')!;

    const rows = rowsForRuleOnDay(fixture, candidates, 15, 60);
    const expectedIds = new Set(
      candidates.filter(r => isViolatingOnDay(fixture.ruleId, fixture.severity, r.id, 15, 60)).map(r => r.id),
    );

    expect(rows.length).toBe(expectedIds.size);
    for (const row of rows) {
      expect(expectedIds.has(row.id as string)).toBe(true);
      expect(row).toHaveProperty('diskState', 'Unattached');
    }
  });
});

// ── Fixture curation against the real, live rule set ───────────────────────────────────────────
// These import lib/rules, which reads the ambient (throwaway) test database — the same one
// tests/setup.ts already isolates per file.

describe('buildAprlFixtures() against the real seeded aprl-v2 pack', () => {
  it('curates a non-empty subset of aprl-v2 rules whose resource types the estate can produce', () => {
    const rules = loadRules();
    const aprlRules = rules.filter(r => r.pack === 'aprl-v2');
    expect(aprlRules.length).toBeGreaterThan(50); // the pack itself; sanity that seeding ran

    const fixtures = buildAprlFixtures(rules);
    expect(fixtures.length).toBeGreaterThan(0);
    for (const f of fixtures) {
      expect(f.resourceTypes.length).toBeGreaterThan(0);
      for (const t of f.resourceTypes) expect(TYPE_META[t]).toBeDefined();
    }
  });

  it('every curated fixture\'s buildRow runs without throwing against a matching estate resource', () => {
    const estate = buildEstate();
    const rules = loadRules();
    const fixtures = buildAprlFixtures(rules);
    const byType = new Map<string, (typeof estate.resources)[number]>();
    for (const r of estate.resources) if (!byType.has(r.type)) byType.set(r.type, r);

    let exercised = 0;
    for (const fixture of fixtures) {
      const sample = byType.get(fixture.resourceTypes[0]);
      if (!sample) continue;
      expect(() => fixture.buildRow(sample)).not.toThrow();
      exercised++;
    }
    expect(exercised).toBeGreaterThan(0);
  });

  it('no APRL fixture reuses a core rule id — the fixturesByRuleId Map must not silently drop one', () => {
    const rules = loadRules();
    const aprlFixtures = buildAprlFixtures(rules);
    const aprlIds = new Set(aprlFixtures.map(f => f.ruleId));
    for (const coreId of CORE_RULE_IDS) expect(aprlIds.has(coreId)).toBe(false);
  });
});

// ── fake-context.ts: the "never fail silently" safety net ─────────────────────────────────────
// runner.ts swallows a per-rule query failure into a log line rather than throwing (so one bad rule
// doesn't abort a real scan) — assertNoQueryFailures exists specifically to turn that back into a
// hard failure for the generator. Prove both halves: the swallow, and the net that catches it.

describe('createFakeContext() query/graph mismatches are caught, not silently empty', () => {
  const estate = buildEstate();
  const identityApps = buildIdentityApps();

  function baseRule(overrides: Partial<Rule> = {}): Rule {
    return {
      id: 'unmatched-rule',
      name: 'Unmatched',
      description: '',
      category: 'reliability',
      severity: 'medium',
      enabled: true,
      type: 'custom',
      scope: { level: 'subscription' },
      resourceTypes: [],
      conditions: [],
      rawKql: 'resources | where type == "this-matches-no-fixture"',
      ...overrides,
    };
  }

  it('a rule with no matching fixture throws when queried directly', async () => {
    const ctx = createFakeContext({
      estate, identityApps, day: 0, totalDays: 5,
      rules: [baseRule()],
      fixturesByRuleId: new Map(),
    });

    await expect(ctx.queryARG(baseRule().rawKql!)).rejects.toThrow(/no fixture matched/);
  });

  it('runRules() turns that into a failed outcome event instead of throwing — and assertNoQueryFailures catches it', async () => {
    const ctx = createFakeContext({
      estate, identityApps, day: 0, totalDays: 5,
      rules: [baseRule()],
      fixturesByRuleId: new Map(),
    });

    // runRules is an async generator (AsyncIterable<RuleRunEvent<Finding>>), not a Promise —
    // draining it is what exercises the try/catch around ctx.queryARG(); a failed rule yields no
    // 'finding' events and a single 'outcome' event with status 'failed' rather than rejecting the
    // whole run (spec 004 — a 'failed' outcome must never resolve the rule's prior findings).
    const events = await drain(runRules([baseRule()], ctx));
    expect(events).toEqual([
      { kind: 'outcome', outcome: { ruleId: 'unmatched-rule', status: 'failed', findingCount: 0 } },
    ]);
    expect(ctx.logs.some(l => l.includes('query failed'))).toBe(true);
    expect(() => assertNoQueryFailures(ctx, 0)).toThrow(/query failure/);
  });

  it('assertNoQueryFailures() passes clean when no failures were logged', () => {
    const ctx = createFakeContext({
      estate, identityApps, day: 0, totalDays: 5,
      rules: [], fixturesByRuleId: new Map(),
    });
    expect(() => assertNoQueryFailures(ctx, 0)).not.toThrow();
  });

  it('an unrecognized Graph path rejects rather than returning an empty/fabricated result', async () => {
    const ctx = createFakeContext({
      estate, identityApps, day: 0, totalDays: 5,
      rules: [], fixturesByRuleId: new Map(),
    });
    await expect(ctx.graphGet!('/bogus')).rejects.toThrow(/unrecognized Graph path/);
  });

  it('the real identity Graph path resolves via graphAppsForDay, not the mismatch guard', async () => {
    // graphAppsForDay() reads Date.now() internally (matching identity-scan.ts's own daysUntil()),
    // so two independent calls a millisecond apart in real wall-clock time produce slightly
    // different endDateTime strings. Freeze time so this test's own comparison call agrees with
    // the one createFakeContext makes inside ctx.graphGet().
    vi.useFakeTimers();
    try {
      const ctx = createFakeContext({
        estate, identityApps, day: 0, totalDays: 5,
        rules: [], fixturesByRuleId: new Map(),
      });
      const apps = await ctx.graphGet!('/applications?$select=id,displayName,appId,passwordCredentials,keyCredentials&$top=999');
      expect(apps).toEqual(graphAppsForDay(identityApps, 0, 5));
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── replay(): the real integration, at a small scale ───────────────────────────────────────────
// Reproduces run.ts's own rule-curation steps (loadRules → filter aprl-v2 → buildAprlFixtures →
// setRulesEnabled) against the ambient test database, then replays a handful of simulated days
// through the real executeTarget()/runCategoryScan()/runRules() pipeline — the same path the full
// 60-day `npm run generate-demo` run already proved works by hand. A small totalDays keeps this
// fast while still exercising every category, including identity.

describe('replay() — small-scale integration against the real scan pipeline', () => {
  it('replays N days with zero query failures and populates findings across every category', async () => {
    const estate = buildEstate();
    const identityApps = buildIdentityApps();

    const allRules = loadRules();
    const aprlRuleIds = allRules.filter(r => r.pack === 'aprl-v2').map(r => r.id);
    const aprlFixtures = buildAprlFixtures(allRules);
    setRulesEnabled(aprlRuleIds, false);
    setRulesEnabled(aprlFixtures.map(f => f.ruleId), true);
    setRulesEnabled(CORE_RULE_IDS, true);

    const fixtures: RuleFixture[] = [...CORE_FIXTURES, ...aprlFixtures];
    const fixturesByRuleId = new Map(fixtures.map(f => [f.ruleId, f]));
    const curatedRules = loadRules();

    const totalDays = 5;
    const scheduleId = 'demo-generator-test-schedule';

    await expect(
      replay({ estate, rules: curatedRules, fixturesByRuleId, identityApps, scheduleId, totalDays }),
    ).resolves.not.toThrow();

    const runs = db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, scheduleId)).all();
    expect(runs).toHaveLength(totalDays);
    for (const run of runs) expect(run.status).toBe('success');

    const allFindings = db.select().from(findings).all();
    const categories = new Set(allFindings.map(f => f.category));
    expect(categories.has('identity')).toBe(true);
    expect(categories.size).toBeGreaterThanOrEqual(4);

    const identityFindings = allFindings.filter(f => f.category === 'identity');
    expect(identityFindings.length).toBeGreaterThan(0);
    for (const f of identityFindings) {
      // App registrations are a Graph concept, not an ARM resource — they have no resource group or
      // region, unlike every ARM-backed finding from the other four categories.
      expect(f.resourceGroup).toBeNull();
      expect(f.location).toBeNull();
    }

    const armFindings = allFindings.filter(f => f.category !== 'identity');
    expect(armFindings.length).toBeGreaterThan(0);
    for (const f of armFindings.slice(0, 20)) {
      expect(f.resourceGroup).not.toBeNull();
      expect(f.location).not.toBeNull();
    }
  }, 30_000);
});
