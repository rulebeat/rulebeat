/**
 * TS-09 · The rule builder and its translator — round-trip coverage.
 *
 * The contract this suite enforces: **whatever the builder can generate, the parser must parse
 * back.** That single property is what stops a rule silently changing meaning when someone opens
 * it for editing — the failure mode that produces no error, no warning, and a customer trusting a
 * check that is no longer checking what they wrote.
 *
 * Every operator gets its own named test, so a failure says which one broke rather than "KQL is
 * wrong somewhere".
 */
import { describe, expect, it } from 'vitest';
import {
  buildQueryFromVisual,
  parseKqlToVisualQuery,
  queryHasTopLevelLimit,
  DEFAULT_PROJECT_COLUMNS,
} from '../src/engine/kql.js';
import type {
  Rule,
  VisualFilterCondition,
  VisualFilterOperator,
  VisualQuery,
} from '../src/engine/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

type BuildTarget = Pick<Rule, 'scope' | 'resourceTypes' | 'projectColumns'>;

const RESOURCE_TARGET: BuildTarget = {
  scope: { level: 'resource' },
  resourceTypes: ['*'],
  projectColumns: DEFAULT_PROJECT_COLUMNS,
};

let seq = 0;
function id(): string {
  return `test-id-${++seq}`;
}

function oneCondition(condition: Omit<VisualFilterCondition, 'id'>): VisualQuery {
  return {
    stages: [{
      id: id(),
      type: 'filter',
      groups: [{ id: id(), conditions: [{ id: id(), ...condition }] }],
    }],
  };
}

/** Pulls the conditions back out of a parsed result, failing loudly if the shape is wrong. */
function parsedConditions(kql: string): VisualFilterCondition[] {
  const parsed = parseKqlToVisualQuery(kql);
  const filterStages = parsed.visualQuery.stages.filter(s => s.type === 'filter');
  expect(filterStages, `expected one filter stage in:\n${kql}`).toHaveLength(1);
  const stage = filterStages[0]!;
  expect(stage.groups, `expected one condition group in:\n${kql}`).toHaveLength(1);
  return stage.groups[0]!.conditions;
}

/**
 * Parses the KQL and regenerates it from the parsed result. When this returns the input unchanged,
 * the round trip preserved the *query* — which is the property that actually matters, and a
 * stronger claim than "the operator label came back the same".
 */
function regenerate(kql: string): string {
  const parsed = parseKqlToVisualQuery(kql);
  return buildQueryFromVisual(parsed.visualQuery, {
    scope: parsed.scope,
    resourceTypes: parsed.resourceTypes.length ? parsed.resourceTypes : ['*'],
    projectColumns: parsed.projectColumns.length ? parsed.projectColumns : DEFAULT_PROJECT_COLUMNS,
  });
}

// ── The operator table ────────────────────────────────────────────────────────
//
// Every operator the visual builder can produce, with a representative value. Anything missing
// here is untested, so the completeness check below asserts the table covers the whole union type.

interface Case {
  operator: VisualFilterOperator;
  field: string;
  value?: string;
  value2?: string;
  values?: string[];
  /**
   * Set when this operator deliberately compiles to KQL that is byte-identical to another
   * operator's, so the parser cannot tell them apart and reads it back as the alias.
   *
   * This is **not** a corruption case and the test does not skip it — it is held to a *stricter*
   * standard instead: the regenerated KQL must be identical to the original, proving the rule
   * still checks exactly the same thing. Only the label shown in the builder changes. See the
   * `aliasing` describe block below, which pins each alias so a genuine parser regression here
   * (one that changed the query, not just the label) still fails.
   */
  readBackAs?: VisualFilterOperator;
  /** Set when the operator compiles to a compound expression that parses back as N conditions. */
  splitsInto?: number;
  /**
   * A **known, unfixed bug**. The test is marked `it.fails`, which asserts that it currently fails —
   * so the bug stays visible in the test output, the suite stays honest, and the moment someone
   * fixes the parser this very test errors ("expected to fail but passed") and forces the marker to
   * be removed. It is deliberately *not* a skip and the assertions are not weakened.
   *
   * Each id below tracks one such bug in the project's bug log.
   */
  knownBug?: string;
}

const CASES: Case[] = [
  // Presence / emptiness — no value
  { operator: 'exists', field: 'properties.osProfile' },
  { operator: 'notExists', field: 'properties.osProfile' },
  { operator: 'isNull', field: 'properties.encryption' },
  { operator: 'isNotNull', field: 'properties.encryption' },
  // isEmpty/isNotEmpty compile to the same isempty()/isnotempty() calls as notExists/exists.
  { operator: 'isEmpty', field: 'name', readBackAs: 'notExists' },
  { operator: 'isNotEmpty', field: 'name', readBackAs: 'exists' },

  // Booleans
  { operator: 'isTrue', field: 'properties.supportsHttpsTrafficOnly' },
  { operator: 'isFalse', field: 'properties.supportsHttpsTrafficOnly' },

  // String comparison
  { operator: 'equals', field: 'location', value: 'westeurope' },
  { operator: 'notEquals', field: 'location', value: 'westeurope' },
  { operator: 'contains', field: 'name', value: 'prod' },
  { operator: 'notContains', field: 'name', value: 'test' },
  { operator: 'startsWith', field: 'name', value: 'vm-' },
  { operator: 'notStartsWith', field: 'name', value: 'tmp-' },
  { operator: 'endsWith', field: 'name', value: '-prod' },
  { operator: 'notEndsWith', field: 'name', value: '-dev' },
  { operator: 'matchesRegex', field: 'name', value: '^vm-[0-9]+$' },
  { operator: 'has', field: 'tags', value: 'owner' },
  { operator: 'notHas', field: 'tags', value: 'owner' },

  // Numeric
  { operator: 'gt', field: 'properties.diskSizeGB', value: '512' },
  { operator: 'gte', field: 'properties.diskSizeGB', value: '512' },
  { operator: 'lt', field: 'properties.diskSizeGB', value: '32' },
  { operator: 'lte', field: 'properties.diskSizeGB', value: '32' },
  // `between` has no single KQL operator — it compiles to `>= a and <= b`, which is genuinely
  // two conditions once parsed back.
  { operator: 'between', field: 'properties.diskSizeGB', value: '32', value2: '512', splitsInto: 2 },

  // Dates
  { operator: 'olderThanDays', field: 'properties.timeCreated', value: '90' },
  { operator: 'withinLastDays', field: 'properties.timeCreated', value: '7' },

  // Arrays
  // Both compile to a parenthesised two-part expression and must come back as one condition — see
  // the compound-expression block below.
  { operator: 'arrayEmpty', field: 'properties.ipRules' },
  { operator: 'arrayNotEmpty', field: 'properties.ipRules' },
  { operator: 'arrayLengthGt', field: 'properties.ipRules', value: '3' },
  { operator: 'arrayLengthLte', field: 'properties.ipRules', value: '1' },
  // arrayContains compiles to the same `contains` KQL as the plain string operator.
  { operator: 'arrayContains', field: 'properties.ipRules', value: '10.0.0.0/8', readBackAs: 'contains' },

  // Lists
  { operator: 'in', field: 'location', values: ['westeurope', 'northeurope'] },
  { operator: 'notIn', field: 'location', values: ['eastus', 'westus'] },
  { operator: 'hasAny', field: 'tags', values: ['owner', 'costCentre'] },
];

describe('TS-09 · the operator table is complete', () => {
  it('09-04 · covers every operator the visual builder can produce', () => {
    // Kept in sync with VisualFilterOperator by hand, and cross-checked against the table — if a
    // new operator is added to the type without a case here, this list has to change too, which is
    // the prompt to add the round-trip test.
    //
    // 'raw' is deliberately absent: it is the parser's passthrough for KQL the builder cannot
    // express, never offered in the operator dropdown, so there is no rule to author with it. Its
    // round trip is covered by the compound-expression block instead.
    const ALL: VisualFilterOperator[] = [
      'exists', 'notExists', 'isNull', 'isNotNull', 'isEmpty', 'isNotEmpty',
      'isTrue', 'isFalse',
      'equals', 'notEquals', 'contains', 'notContains',
      'startsWith', 'notStartsWith', 'endsWith', 'notEndsWith',
      'matchesRegex', 'has', 'notHas', 'hasAny',
      'gt', 'gte', 'lt', 'lte', 'between',
      'olderThanDays', 'withinLastDays',
      'arrayEmpty', 'arrayNotEmpty', 'arrayLengthGt', 'arrayLengthLte', 'arrayContains',
      'in', 'notIn',
    ];
    const covered = CASES.map(c => c.operator);
    expect([...ALL].sort()).toEqual([...new Set(covered)].sort());
  });
});

describe('TS-09 · generate → parse → compare, per operator', () => {
  for (const testCase of CASES) {
    const { operator, field, readBackAs, splitsInto, knownBug } = testCase;
    const test = knownBug ? it.fails : it;
    const label = knownBug ? ` [known bug ${knownBug}]` : '';

    test(`09-04 · ${operator} survives the round trip${label}`, () => {
      const kql = buildQueryFromVisual(oneCondition(testCase), RESOURCE_TARGET);

      // The generator must actually emit a filter — an operator that silently produced nothing
      // would otherwise "round-trip" through an empty query and look fine.
      expect(kql, `${operator} generated no | where clause`).toMatch(/\|\s*where/);

      // The property that matters most. Two forms of it:
      //
      //  - **Stability**, asserted for every operator with no exceptions: a second parse →
      //    regenerate cycle must not change the query again. A round trip that keeps rewriting the
      //    rule would corrupt it a little more every time it was opened, which is the genuinely
      //    dangerous failure mode.
      //  - **Exactness**, for every operator that maps to a single KQL expression: the first cycle
      //    must return the query untouched. Compound operators (`between`) are excused from this
      //    one because they legitimately re-emit as an explicit parenthesised group.
      const once = regenerate(kql);
      expect(regenerate(once), `${operator} keeps rewriting its own KQL on every parse cycle`).toBe(once);

      if (!splitsInto) {
        expect(once, `${operator} changed its own KQL on a parse → regenerate cycle`).toBe(kql);
      } else {
        // Still has to be the same query, just allowed to gain the grouping parentheses.
        expect(once.replace(/[()]/g, '')).toBe(kql.replace(/[()]/g, ''));
      }

      const conditions = parsedConditions(kql);
      expect(conditions, `${operator} parsed back as ${conditions.length} condition(s)`)
        .toHaveLength(splitsInto ?? 1);

      const back = conditions[0]!;
      expect(back.field).toBe(field);

      // A compound operator's parts are individually verified by the `splitsInto` block below.
      if (splitsInto) return;

      expect(back.operator, `${operator} parsed back as '${back.operator}'`).toBe(readBackAs ?? operator);

      if (testCase.values) {
        expect(back.values ?? []).toEqual(testCase.values);
      } else if (testCase.value !== undefined) {
        expect(back.value).toBe(testCase.value);
      }
      if (testCase.value2 !== undefined && !readBackAs) {
        expect(back.value2).toBe(testCase.value2);
      }
    });
  }
});

describe('TS-09 · aliased operators — same query, different label', () => {
  /**
   * Each pair below compiles to identical KQL, which is why the parser reads the second back as the
   * first. Pinned individually so that if the generator ever *changes* one of them, this fails —
   * the aliasing is documented behaviour, not an excuse for the parser to be loose.
   */
  const ALIASES: Array<[Case, Case]> = [
    [{ operator: 'notExists', field: 'name' }, { operator: 'isEmpty', field: 'name' }],
    [{ operator: 'exists', field: 'name' }, { operator: 'isNotEmpty', field: 'name' }],
    [
      { operator: 'contains', field: 'properties.ipRules', value: '10.0.0.0/8' },
      { operator: 'arrayContains', field: 'properties.ipRules', value: '10.0.0.0/8' },
    ],
  ];

  for (const [canonical, alias] of ALIASES) {
    it(`${alias.operator} compiles to exactly the same KQL as ${canonical.operator}`, () => {
      const a = buildQueryFromVisual(oneCondition(canonical), RESOURCE_TARGET);
      const b = buildQueryFromVisual(oneCondition(alias), RESOURCE_TARGET);
      expect(b).toBe(a);
    });
  }
});

describe('TS-09 · between compiles to a bounded range', () => {
  const kql = buildQueryFromVisual(
    oneCondition({ operator: 'between', field: 'properties.diskSizeGB', value: '32', value2: '512' }),
    RESOURCE_TARGET,
  );

  it('emits both bounds', () => {
    expect(kql).toContain('>= 32');
    expect(kql).toContain('<= 512');
  });

  it('parses back as a gte + lte pair on the same field, joined with and', () => {
    const [lower, upper] = parsedConditions(kql);
    expect(lower!.operator).toBe('gte');
    expect(lower!.value).toBe('32');
    expect(upper!.operator).toBe('lte');
    expect(upper!.value).toBe('512');
    expect(upper!.join).toBe('and');
    expect(lower!.field).toBe('properties.diskSizeGB');
    expect(upper!.field).toBe('properties.diskSizeGB');
  });
});

describe('TS-09 · a fully parenthesised where clause is not lost', () => {
  /**
   * Regression test for a real data-loss bug found on 2026-07-30 by the operator table above.
   *
   * The generator emits a single condition group as `| where (A and B)`. The parser only unwrapped
   * those outer parentheses when the clause also contained a top-level `or`, so this form parsed to
   * zero conditions — and regenerating from that dropped the `| where` line completely. A `between`
   * rule opened in the editor twice therefore stopped filtering and reported every resource in the
   * tenant as a finding, with no error anywhere.
   */
  it('parses a where clause wrapped entirely in parentheses', () => {
    const kql = [
      'Resources',
      '| where (tolong(properties.diskSizeGB) >= 32 and tolong(properties.diskSizeGB) <= 512)',
      '| project id, name',
    ].join('\n');

    const conditions = parsedConditions(kql);
    expect(conditions).toHaveLength(2);
    expect(conditions[0]!.operator).toBe('gte');
    expect(conditions[1]!.operator).toBe('lte');
  });

  it('never drops the where clause when regenerating a parenthesised group', () => {
    const kql = 'Resources\n| where (name startswith \'vm-\' and location =~ \'westeurope\')\n| project id';
    expect(regenerate(kql)).toMatch(/\|\s*where/);
  });

  it('unwraps redundantly nested parentheses', () => {
    const kql = 'Resources\n| where ((name startswith \'vm-\'))\n| project id';
    const conditions = parsedConditions(kql);
    expect(conditions).toHaveLength(1);
    expect(conditions[0]!.operator).toBe('startsWith');
    expect(conditions[0]!.value).toBe('vm-');
  });

  it('leaves load-bearing parentheses alone — (A or B) and C keeps its grouping', () => {
    const kql = [
      'Resources',
      "| where (location =~ 'westeurope' or location =~ 'northeurope') and name startswith 'vm-'",
      '| project id',
    ].join('\n');

    const parsed = parseKqlToVisualQuery(kql);
    const stage = parsed.visualQuery.stages.find(s => s.type === 'filter');
    expect(stage).toBeDefined();
    // Two OR'd locations must not collapse into the same group as the name filter — that would
    // change the query's meaning from (A or B) and C into A or B or C.
    const allConditions = stage!.groups.flatMap(g => g.conditions);
    expect(allConditions.length).toBeGreaterThanOrEqual(3);
    expect(regenerate(kql)).toContain('or');
  });
});

describe('TS-09 · compound expressions inside one where clause', () => {
  /**
   * Three of the five bugs found on 2026-07-30 (RB-QA-002/003/004) shared one root cause: a single
   * `| where` clause can contain a parenthesised sub-expression that is *not* the whole clause, and
   * the parser handed those to the single-condition matcher, which cannot read them. Two operators
   * generate exactly that shape on their own (`arrayEmpty`, `arrayNotEmpty`), and hand-written KQL
   * produces it whenever an OR group is ANDed with anything.
   */
  const allConditions = (kql: string): VisualFilterCondition[] => {
    const parsed = parseKqlToVisualQuery(kql);
    const stage = parsed.visualQuery.stages.find(s => s.type === 'filter');
    expect(stage, `expected a filter stage in:\n${kql}`).toBeDefined();
    return stage!.groups.flatMap(g => g.conditions);
  };

  it('reads a generated arrayEmpty check as one condition, not two, when ANDed with another filter', () => {
    const kql = [
      'Resources',
      "| where (isnull(properties.ipRules) or array_length(properties.ipRules) == 0) and name startswith 'vm-'",
      '| project id',
    ].join('\n');

    const conditions = allConditions(kql);
    expect(conditions.map(c => c.operator)).toEqual(['arrayEmpty', 'startsWith']);
    // The "or empty" half must survive regeneration — dropping it narrows the rule to "is missing"
    // and the violations it stops reporting are invisible.
    expect(regenerate(kql)).toContain('array_length(properties.ipRules) == 0');
  });

  it('keeps an OR group stable across two parse cycles when it is ANDed with another filter', () => {
    const kql = [
      'Resources',
      "| where (location =~ 'westeurope' or location =~ 'northeurope') and name startswith 'vm-'",
      '| project id',
    ].join('\n');

    const once = regenerate(kql);
    expect(once).toContain("location =~ 'northeurope'");
    expect(once).toContain("name startswith 'vm-'");
    expect(regenerate(once), 'the nested OR group keeps being rewritten on every cycle').toBe(once);
  });

  /**
   * A condition the builder has no operator for — here numeric equality against a computed column,
   * which 12 of the 143 APRL pack rules use — is carried through verbatim as `operator: 'raw'`, the
   * same passthrough the advanced *stages* already get. The builder deliberately reads more KQL than
   * it can author; what it cannot express it must keep, not drop and warn about.
   */
  it('keeps a condition it cannot map to the builder, verbatim', () => {
    const kql = [
      'Resources',
      '| extend diskCount = array_length(properties.storageProfile.dataDisks)',
      '| where diskCount == 1',
      '| project id',
    ].join('\n');

    const conditions = allConditions(kql);
    expect(conditions.map(c => c.operator)).toEqual(['raw']);
    expect(conditions[0]!.rawExpr).toBe('diskCount == 1');

    const once = regenerate(kql);
    expect(once).toContain('diskCount == 1');
    expect(regenerate(once), 'a passthrough condition must not drift').toBe(once);
  });

  /**
   * The subtler half of the same problem: these parse *successfully* into a condition whose field is
   * an expression the generator has no way to write back (`array_length(x)`, `['threshold']`), so the
   * condition looks fine right up until it silently disappears from the regenerated query. Parsing
   * something the generator cannot re-emit is the same as not parsing it.
   */
  const UNWRITABLE = [
    ['a function call as the field', '| where array_length(replicaSets) < 2', 'array_length(replicaSets) < 2'],
    ['bracket notation on a computed column', "| where isnull(['threshold'])", "isnull(['threshold'])"],
  ] as const;

  for (const [label, clause, expected] of UNWRITABLE) {
    it(`keeps a condition the generator cannot write back — ${label}`, () => {
      const kql = ['Resources', '| extend replicaSets = properties.replicaSets', clause, '| project id'].join('\n');
      const once = regenerate(kql);
      expect(once, 'the clause vanished from the regenerated query').toContain(expected);
      expect(regenerate(once)).toBe(once);
    });
  }

  /**
   * RB-QA-008, fixed by spec 016. A whole unsupported *pipe* — `| union (...)` — used to be warned
   * about and dropped, taking its entire sub-query with it. It is now carried through verbatim as a
   * RawStage, the same passthrough idea `operator: 'raw'`/`exprType: 'raw'` already use one level down.
   */
  it('keeps an unsupported pipe rather than dropping it [RB-QA-008]', () => {
    const kql = [
      'Resources',
      "| where type =~ 'microsoft.compute/virtualmachines'",
      "| union (Resources | where type =~ 'microsoft.compute/disks')",
      '| project id',
    ].join('\n');

    const parsed = parseKqlToVisualQuery(kql);
    const rawStages = parsed.visualQuery.stages.filter(s => s.type === 'raw');
    expect(rawStages).toHaveLength(1);
    expect((rawStages[0] as { clause: string }).clause).toContain('union');
    // A passthrough is normal, supported behaviour — same rule as the condition-level passthrough above.
    expect(parsed.warnings).toEqual([]);

    const once = regenerate(kql);
    expect(once).toContain('union');
    expect(regenerate(once), 'a union stage must not keep rewriting on every cycle').toBe(once);
  });

  /**
   * Real committed data, not a synthesized shape: `data/packs/aprl-v2.json`'s "Ensure the Backend
   * Pool contains at least two instances" rule puts a mid-pipeline `| project name, feConfigName, id`
   * immediately before its `| union (...)`, with the true output `| project recommendationId = ...`
   * genuinely last. Before this spec, `lastProjectIdx` found *any* last `project` clause and treated
   * it as output metadata — on this exact shape that would have grabbed the mid-pipeline one and
   * silently moved it after the union, changing what the union's own pipeline receives.
   */
  it('real APRL rule: a project immediately before a union stays before it, not after [RB-QA-008]', () => {
    const kql = [
      'resources',
      '| where type == "microsoft.network/loadbalancers"',
      '| where location in~ ("westeurope", "eastus")',
      "| where tolower(sku.name) != 'basic'",
      '| mv-expand feIPconfigs = properties.frontendIPConfigurations',
      '| extend',
      '    feConfigName = (feIPconfigs.name),',
      '    PrivateSubnetId = toupper(feIPconfigs.properties.subnet.id),',
      '    PrivateIPZones = feIPconfigs.zones,',
      '    PIPid = toupper(feIPconfigs.properties.publicIPAddress.id),',
      '    JoinID = toupper(id)',
      '| where isnotempty(PrivateSubnetId)',
      '| where isnull(PrivateIPZones) or array_length(PrivateIPZones) < 2',
      '| project name, feConfigName, id',
      '| union (resources',
      '    | where type == "microsoft.network/loadbalancers"',
      '    | where location in~ ("westeurope", "eastus")',
      "    | where tolower(sku.name) != 'basic'",
      '    | mv-expand feIPconfigs = properties.frontendIPConfigurations',
      '    | extend',
      '        feConfigName = (feIPconfigs.name),',
      '        PIPid = toupper(feIPconfigs.properties.publicIPAddress.id),',
      '        JoinID = toupper(id)',
      '    | where isnotempty(PIPid)',
      '    | join kind=innerunique (',
      '        resources',
      '        | where type == "microsoft.network/publicipaddresses"',
      '        | where location in~ ("westeurope", "westus3")',
      '        | where isnull(zones) or array_length(zones) < 2',
      '        | extend',
      "            LBid = toupper(substring(properties.ipConfiguration.id, 0, indexof(properties.ipConfiguration.id, '/frontendIPConfigurations'))),",
      '            InnerID = toupper(id)',
      '    ) on $left.PIPid == $right.InnerID)',
      '| project recommendationId = "621dbc78-3745-4d32-8eac-9e65b27b7512", name, id, tags, param1="Zones: No Zone or Zonal", param2=strcat("Frontend IP Configuration:", " ", feConfigName)',
    ].join('\n');

    const once = regenerate(kql);
    const midProjectIdx = once.indexOf('| project name, feConfigName, id');
    const unionIdx = once.indexOf('| union');
    const outputProjectIdx = once.lastIndexOf('| project recommendationId');

    expect(midProjectIdx, 'mid-pipeline project clause vanished').toBeGreaterThan(-1);
    expect(unionIdx, 'union clause vanished').toBeGreaterThan(-1);
    expect(outputProjectIdx, 'output project clause vanished').toBeGreaterThan(-1);
    expect(midProjectIdx, 'mid-pipeline project must stay before the union it feeds').toBeLessThan(unionIdx);
    expect(outputProjectIdx, 'output project must stay genuinely last').toBeGreaterThan(unionIdx);

    expect(regenerate(once), 'the union stage keeps being rewritten on every cycle').toBe(once);
  });

  /**
   * RB-QA-008b / spec 027. `data/packs/aprl-v2.json`'s "Monitor CPU Utilization" rule wraps its
   * first union branch in a leading outer paren before the table line —
   * `(\nresources\n| where ...\n)\n| union (...)`. Before the fix, the table-line detector only
   * looked at `rawLines[0]` (the bare `(`), so it never recognized `resources` as the table, scope
   * detection silently fell back to the default, and the wrap's own closing `)` got glued onto the
   * last real clause of the first branch — producing regenerated KQL with a stray, unbalanced paren.
   */
  it('drops a purely cosmetic leading-paren union wrap without corrupting output (RB-QA-008b)', () => {
    const kql = [
      '(',
      'resources',
      '| where [\'type\'] == "microsoft.avs/privateclouds"',
      '| extend scopeId = tolower(tostring(id))',
      "| project ['scopeId'], name, id, tags",
      '| where isnull([\'threshold\'])',
      '| project recommendationId = "x", name, id, tags',
      ')',
      '| union (',
      'resources',
      '| where [\'type\'] == "microsoft.avs/privateclouds"',
      '| project recommendationId = "y", name, id, tags',
      ')',
    ].join('\n');

    const parsed = parseKqlToVisualQuery(kql);
    expect(parsed.scope.level, 'the real table line after the wrap must be seen').toBe('resource');

    const once = regenerate(kql);
    const opens = (once.match(/\(/g) ?? []).length;
    const closes = (once.match(/\)/g) ?? []).length;
    expect(opens, 'regenerated query must have balanced parens').toBe(closes);

    // The first branch's own trailing project clause must survive uncorrupted — not have the
    // wrap's closing paren glued onto it as literal text.
    expect(once).toContain('project recommendationId = "x", name, id, tags');
    expect(once).not.toMatch(/project recommendationId = "x", name, id, tags\s*\)/);

    expect(regenerate(once), 'two-cycle regeneration must be a fixed point').toBe(once);
  });

  /**
   * Same shape, but the wrapped first branch is container-scoped. This can only pass if the fix
   * genuinely re-points table-line detection at the line after the leading `(` — `resourceTypes`
   * parses independently from a later `where type ==` clause and cannot prove that on its own.
   */
  it('detects container scope through a leading-paren union wrap (RB-QA-008b)', () => {
    const kql = [
      '(',
      "ResourceContainers | where type =~ 'microsoft.resources/subscriptions'",
      '| where name == "x"',
      '| project recommendationId = "x", name, id',
      ')',
      '| union (',
      "ResourceContainers | where type =~ 'microsoft.resources/subscriptions'",
      '| project recommendationId = "y", name, id',
      ')',
    ].join('\n');

    const parsed = parseKqlToVisualQuery(kql);
    expect(parsed.scope.level).toBe('subscription');

    const once = regenerate(kql);
    const opens = (once.match(/\(/g) ?? []).length;
    const closes = (once.match(/\)/g) ?? []).length;
    expect(opens).toBe(closes);
    expect(regenerate(once)).toBe(once);
  });

  /**
   * A first-line-inline union (`Resources | union (`) must be completely unaffected by the
   * leading-wrap fix above — `rawLines[0]` here is `'Resources | union ('`, not a bare `(`, so
   * `leadingWrapped` is false and the union's own legitimate closing paren must not be discarded.
   */
  it('does not disturb a first-line-inline union clause (RB-QA-008b regression guard)', () => {
    const kql = [
      'Resources | union (',
      'Resources',
      '| project recommendationId = "y", name, id, tags',
      ')',
      '| project recommendationId = "z", name, id, tags',
    ].join('\n');

    const once = regenerate(kql);
    const opens = (once.match(/\(/g) ?? []).length;
    const closes = (once.match(/\)/g) ?? []).length;
    expect(opens, 'the union clause\'s own closing paren must survive').toBe(closes);
    expect(once).toContain('| union');
    expect(regenerate(once)).toBe(once);
  });

  /**
   * A first-line-inline union that is also the pipeline's OWN LAST CLAUSE — nothing after its
   * closing `)` — corrupts output-column detection (RB-QA-008c / spec 028). `leadingWrapped` is
   * false here (`rawLines[0]` is `'Resources | union ('`, not a bare `(`), so RB-QA-008b's wrap fix
   * does not engage; the bug is `parenDepth` starting at 0 even though a `(` was already opened
   * inline on the first line, so the loop walks every line inside the subquery one paren short of
   * reality and glues the union's real closing `)` onto whatever it thinks is the last clause —
   * here, the subquery's own `| project` line, which is then misread as the pipeline's trailing
   * output project.
   */
  it('does not corrupt output columns for a trailing first-line-inline union with no clause after it (RB-QA-008c)', () => {
    const kql = [
      'Resources | union (',
      'Resources',
      '| project recommendationId = "y", name, id, tags',
      ')',
    ].join('\n');

    // No entry in projectColumns may carry the union's stray closing paren or a newline — asserted
    // directly on the parsed array (Codex challenge §3 AMBIGUOUS), not a broad regex over the whole
    // regenerated string, since the union branch's own legitimate inner `project` clause is expected
    // to have its own `)` right after it in the source.
    const parsed = parseKqlToVisualQuery(kql);
    for (const col of parsed.projectColumns) {
      expect(col, `projectColumns must not carry the union's paren/newline: ${JSON.stringify(parsed.projectColumns)}`).not.toMatch(/[)\n]/);
    }

    const once = regenerate(kql);
    const opens = (once.match(/\(/g) ?? []).length;
    const closes = (once.match(/\)/g) ?? []).length;
    expect(opens, 'regenerated query must have balanced parens').toBe(closes);

    // The union's inner subquery must survive intact rather than being silently dropped while a
    // balance-only check still passes. This is the parser's "never lose anything" contract; see
    // docs/engineering/conventions/kql.md.
    expect(once).toContain('| union');
    expect(once).toContain('recommendationId = "y"');

    expect(regenerate(once), 'two-cycle regeneration must be a fixed point').toBe(once);
  });

  it('carries an unmappable condition alongside ones it understands, without warning', () => {
    const kql = [
      'Resources',
      "| where name startswith 'vm-' and diskCount == 1",
      '| project id',
    ].join('\n');

    expect(allConditions(kql).map(c => c.operator)).toEqual(['startsWith', 'raw']);
    // No warning: a passthrough is normal, supported behaviour, not a problem to report.
    expect(parseKqlToVisualQuery(kql).warnings).toEqual([]);
    expect(regenerate(kql)).toContain('diskCount == 1');
  });
});

describe('TS-09 · quote-aware splitting — and/or, comma-list, escaped quotes [RB-RM-006]', () => {
  /**
   * Before spec 040, `splitTopLevelOps()` split a where clause on every top-level ` and `/` or `
   * substring with no awareness of string literals — a condition value that itself contained one of
   * those substrings (a resource name, a tag value) split the clause in the wrong place.
   */
  const allConditions = (kql: string): VisualFilterCondition[] => {
    const parsed = parseKqlToVisualQuery(kql);
    const stage = parsed.visualQuery.stages.find(s => s.type === 'filter');
    expect(stage, `expected a filter stage in:\n${kql}`).toBeDefined();
    return stage!.groups.flatMap(g => g.conditions);
  };

  it('does not split a clause on "and" hiding inside a quoted value', () => {
    const kql = [
      'Resources',
      "| where name == 'prod and staging' and location =~ 'westeurope'",
      '| project id',
    ].join('\n');

    const conditions = allConditions(kql);
    expect(conditions.map(c => c.operator)).toEqual(['equals', 'equals']);
    expect(conditions[0]!.value).toBe('prod and staging');
    expect(conditions[1]!.value).toBe('westeurope');

    const once = regenerate(kql);
    expect(once).toContain("name =~ 'prod and staging'");
    expect(regenerate(once)).toBe(once);
  });

  it('does not split a clause on "or" hiding inside a quoted value', () => {
    const kql = [
      'Resources',
      "| where name == 'east or west' and location =~ 'westeurope'",
      '| project id',
    ].join('\n');

    const conditions = allConditions(kql);
    expect(conditions.map(c => c.operator)).toEqual(['equals', 'equals']);
    expect(conditions[0]!.value).toBe('east or west');
  });

  /**
   * esc() escapes an embedded apostrophe as `\'`. A backslash-escaped quote must not be mistaken
   * for the string's real closing quote while scanning for the next top-level `and`/`or` — getting
   * this wrong would make the scanner think the string ended early, then read the real `'westeurope'`
   * literal a few characters later as a fresh string open, swallowing the real ` and ` between the
   * second and third conditions and losing a condition outright. (The single-condition value regexes
   * elsewhere in this file are not themselves escape-aware — that is a separate, pre-existing gap,
   * not this spec's scope — so the first condition here is expected to fall back to a `raw`
   * passthrough. What this test guards is that the *split* stays correct regardless.)
   */
  it('does not treat a backslash-escaped quote inside a value as the string terminator', () => {
    const kql = [
      'Resources',
      "| where name contains 'editor\\'s note' and location =~ 'westeurope' and kind == 'prod'",
      '| project id',
    ].join('\n');

    const conditions = allConditions(kql);
    expect(conditions.map(c => c.operator)).toEqual(['raw', 'equals', 'equals']);
    expect(conditions[0]!.rawExpr).toContain("editor\\'s note");
    expect(conditions[1]!.value).toBe('westeurope');
    expect(conditions[2]!.value).toBe('prod');

    const once = regenerate(kql);
    expect(once).toContain("location =~ 'westeurope'");
    expect(once).toContain("kind =~ 'prod'");
    expect(regenerate(once)).toBe(once);
  });

  it('does not split an "in" value list on a comma inside one of its quoted values', () => {
    const kql = buildQueryFromVisual(oneCondition({
      operator: 'in', field: 'tags', values: ['east, west', 'north'],
    }), RESOURCE_TARGET);

    const conditions = parsedConditions(kql);
    expect(conditions[0]!.values).toEqual(['east, west', 'north']);

    const once = regenerate(kql);
    expect(regenerate(once)).toBe(once);
    expect(once).toBe(kql);
  });

  it('does not split a "hasAny" value list on a comma inside a quoted value with an escaped quote', () => {
    const kql = buildQueryFromVisual(oneCondition({
      operator: 'hasAny', field: 'tags', values: ["owner's, deputy's", 'costCentre'],
    }), RESOURCE_TARGET);

    const conditions = parsedConditions(kql);
    expect(conditions[0]!.values).toEqual(["owner's, deputy's", 'costCentre']);
  });
});

describe('TS-09 · | limit is a documented alias of | take, not silently dropped [RB-RM-006]', () => {
  it('parses | limit N into the same LimitStage | take N produces', () => {
    const kql = ['Resources', "| where name startswith 'vm-'", '| limit 50'].join('\n');
    const parsed = parseKqlToVisualQuery(kql);
    const limitStage = parsed.visualQuery.stages.find(s => s.type === 'limit');
    expect(limitStage, 'the | limit clause was dropped instead of parsed').toBeDefined();
    expect(limitStage).toMatchObject({ mode: 'take', count: 50 });
  });

  it('regenerates | limit as | take — the documented alias, not a round-trip loss', () => {
    const kql = ['Resources', "| where name startswith 'vm-'", '| limit 50'].join('\n');
    const once = regenerate(kql);
    expect(once).toContain('| take 50');
    expect(once).not.toMatch(/\|\s*limit\b/i);
    // Canonicalizing to `take` must be a fixed point, not a value that keeps drifting.
    expect(regenerate(once)).toBe(once);
  });

  it('flags a raw rule using | limit as capped, the same as | take', () => {
    const kql = ['Resources', "| where name startswith 'vm-'", '| limit 50'].join('\n');
    expect(queryHasTopLevelLimit(kql)).toBe(true);
  });
});

describe('TS-09 · clauses written on the table line', () => {
  /**
   * The generator emits the three container scopes as a single line — `ResourceContainers | where
   * type =~ 'microsoft.resources/subscriptions'` — so the clause that *defines the scope* lives on
   * the table line. Pasted Portal queries do the same thing with ordinary filters. Anything the
   * parser only looks for from line two onward is therefore invisible in exactly the case the
   * generator itself produces.
   */
  const SCOPES = [
    ['subscription', 'microsoft.resources/subscriptions'],
    ['resourceGroup', 'microsoft.resources/subscriptions/resourcegroups'],
    ['managementGroup', 'microsoft.management/managementgroups'],
  ] as const;

  for (const [level, marker] of SCOPES) {
    it(`keeps ${level} scope when the scope marker sits on the table line`, () => {
      const kql = buildQueryFromVisual(
        oneCondition({ field: 'name', operator: 'startsWith', value: 'prod-' }),
        { scope: { level }, resourceTypes: ['*'], projectColumns: DEFAULT_PROJECT_COLUMNS },
      );
      expect(kql).toContain(marker);

      const parsed = parseKqlToVisualQuery(kql);
      expect(parsed.scope.level, `${level} scope was lost on parse`).toBe(level);
      // The scope marker must not survive as a *condition* either — it belongs to the scope, and
      // showing it in the builder would invite the user to delete it.
      expect(regenerate(kql)).toBe(kql);
    });
  }

  it('reads a filter written on the same line as the table', () => {
    const kql = "Resources | where name startswith 'vm-'\n| project id, name";
    const parsed = parseKqlToVisualQuery(kql);
    const conditions = parsed.visualQuery.stages
      .filter(s => s.type === 'filter')
      .flatMap(s => s.groups.flatMap(g => g.conditions));
    expect(conditions.map(c => c.operator)).toEqual(['startsWith']);
  });
});

describe('TS-09 · generated KQL is stable', () => {
  it('09-19 · building the same rule twice produces identical KQL', () => {
    const build = () => buildQueryFromVisual(
      oneCondition({ field: 'location', operator: 'equals', value: 'westeurope' }),
      RESOURCE_TARGET,
    );
    expect(build()).toBe(build());
  });

  it('09-19 · re-generating from a parsed query does not drift', () => {
    const first = buildQueryFromVisual(
      oneCondition({ field: 'name', operator: 'startsWith', value: 'vm-' }),
      RESOURCE_TARGET,
    );
    const parsed = parseKqlToVisualQuery(first);
    const second = buildQueryFromVisual(parsed.visualQuery, {
      scope: parsed.scope,
      resourceTypes: parsed.resourceTypes.length ? parsed.resourceTypes : ['*'],
      projectColumns: parsed.projectColumns.length ? parsed.projectColumns : DEFAULT_PROJECT_COLUMNS,
    });
    expect(second).toBe(first);
  });
});
