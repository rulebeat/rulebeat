/**
 * The pure steps of rule seeding (ticket #163, #246): version ordering, definition comparison, and
 * what the plan does with a row left on the removed "Before versioning" pseudo-version.
 */
import { describe, expect, it } from 'vitest';
import {
  APRL_QUERY_CORRECTION, canonicalDefinition, compareVersions, planRuleSeeding, sameDefinition, versionKey, versionSortKey,
  type StoredRuleRow,
} from '@/lib/rule-versions';
import { LEGACY_PSEUDO_VERSION, catalogueOf, shippedRule } from '../helpers/catalogue';

describe('compareVersions', () => {
  it('orders semver numerically, not as text', () => {
    expect(compareVersions('semver', '1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('semver', '1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('semver', '1.0', '1.0.1')).toBeLessThan(0);
  });

  it('orders commit timestamps on the same day by time', () => {
    expect(compareVersions('upstream-commit-date', '2026-06-08T13:06:47Z', '2026-06-08T09:00:00Z')).toBeGreaterThan(0);
    expect(compareVersions('upstream-commit-date', '2026-06-08T09:00:00Z', '2026-07-01T00:00:00Z')).toBeLessThan(0);
  });

  it('compares commit timestamps as instants, whatever offset they are written in', () => {
    // 15:00+02:00 is 13:00Z: earlier than 13:30Z although it sorts later as text.
    expect(compareVersions('upstream-commit-date', '2026-06-08T15:00:00+02:00', '2026-06-08T13:30:00Z')).toBeLessThan(0);
  });

  it('orders upstream release tags numerically, ignoring a leading v', () => {
    expect(compareVersions('upstream-release', 'v2.10.0', 'v2.9.1')).toBeGreaterThan(0);
  });

  it('falls back to text order for a version the scheme cannot parse', () => {
    expect(compareVersions('upstream-release', 'rc-b', 'rc-a')).toBeGreaterThan(0);
  });
});

describe('versionSortKey', () => {
  /** Sorts by the key as a database would: plain code-unit string comparison. */
  const inKeyOrder = (scheme: Parameters<typeof versionSortKey>[0], versions: string[]) =>
    [...versions].sort((a, b) => {
      const [ka, kb] = [versionSortKey(scheme, a), versionSortKey(scheme, b)];
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

  it('orders semver numerically as plain text, so 1.10.0 follows 1.9.0 and 1.2 equals 1.2.0', () => {
    expect(inKeyOrder('semver', ['1.10.0', '1.2.0', '2.0.0', '1.9.0', '1.0.10', '1.0.9'])).toEqual(
      ['1.0.9', '1.0.10', '1.2.0', '1.9.0', '1.10.0', '2.0.0'],
    );
    expect(versionSortKey('semver', '1.2')).toBe(versionSortKey('semver', '1.2.0'));
  });

  it('orders commit timestamps as instants, whatever offset or precision they are written in', () => {
    const early = '2026-06-08T15:00:00+02:00'; // 13:00Z
    const late = '2026-06-08T13:30:00Z';
    expect(inKeyOrder('upstream-commit-date', [late, early])).toEqual([early, late]);
    expect(versionSortKey('upstream-commit-date', '2026-06-08T13:06:47Z')).toBe(versionSortKey('upstream-commit-date', '2026-06-08T13:06:47.000Z'));
  });

  it('pads upstream release tags like semver when they are numeric and keeps the raw text otherwise', () => {
    expect(inKeyOrder('upstream-release', ['v2.10.0', 'v2.9.1'])).toEqual(['v2.9.1', 'v2.10.0']);
    expect(versionSortKey('upstream-release', 'rc-1')).toBe('rc-1');
  });

  it('agrees with compareVersions for every pair', () => {
    const versions = ['0.9.0', '1.0.0', '1.0.1', '1.10.0', '2'];
    for (const a of versions) for (const b of versions) {
      const [ka, kb] = [versionSortKey('semver', a), versionSortKey('semver', b)];
      expect(Math.sign(compareVersions('semver', a, b)), `${a} vs ${b}`).toBe(ka < kb ? -1 : ka > kb ? 1 : 0);
    }
  });
});

describe('sameDefinition', () => {
  const base = shippedRule().definition;

  it('ignores key order and treats the same content as equal', () => {
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as typeof base;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(base));
    expect(sameDefinition(base, reordered)).toBe(true);
    expect(canonicalDefinition(base)).toBe(canonicalDefinition(reordered));
  });

  it('sees a change in any definition field', () => {
    expect(sameDefinition(base, { ...base, severity: 'high' })).toBe(false);
    expect(sameDefinition(base, { ...base, rawKql: base.rawKql + ' | take 5' })).toBe(false);
    expect(sameDefinition(base, { ...base, conditionGroups: [{ id: 'g', conditions: [] } as never] })).toBe(false);
  });
});

describe('planRuleSeeding', () => {
  function stored(over: Partial<StoredRuleRow> = {}): StoredRuleRow {
    const def = shippedRule().definition;
    return {
      id: 'aaaaaaaa-0000-4000-8000-000000000001', name: def.name, description: def.description, category: def.category,
      severity: def.severity, enabled: false, scope: JSON.stringify(def.scope), resourceTypes: JSON.stringify(def.resourceTypes),
      conditions: '[]', conditionGroups: null, visualQuery: null, projectColumns: null, rawKql: def.rawKql,
      queryBackend: def.queryBackend, kind: def.kind, graphQuery: null, logsQuery: null, type: 'builtin',
      pack: 'rulebeat-core', version: '1.0.0', retiredAt: null, originRuleId: null, originVersion: null,
      ...over,
    };
  }

  it('records a version with the sort key its scheme gives it', () => {
    const rule = shippedRule({ versionScheme: 'upstream-commit-date', version: '2026-06-08T13:06:47Z' });
    const plan = planRuleSeeding({
      catalogue: catalogueOf(rule),
      rows: [stored({ version: null, enabled: true, severity: 'critical' })],
      recorded: new Set<string>(),
    });
    const recordedKeys = Object.fromEntries(
      plan.flatMap(a => (a.action === 'record' ? [[a.version, a.sortKey]] : [])),
    );
    expect(recordedKeys).toEqual({ '2026-06-08T13:06:47Z': '2026-06-08T13:06:47.000Z' });
  });

  it('never plans a record of the removed pseudo-version, for any row state', () => {
    const rule = shippedRule();
    for (const enabled of [true, false]) for (const version of [null, LEGACY_PSEUDO_VERSION, '1.0.0']) {
      const plan = planRuleSeeding({ catalogue: catalogueOf(rule), rows: [stored({ version, enabled, severity: 'critical' })], recorded: new Set() });
      expect(plan.filter(a => a.action === 'record').map(a => a.action === 'record' && a.version), `${enabled} ${version}`)
        .toEqual([rule.version]);
    }
  });

  it('on the first upgrade moves a differing row with no version to the shipped version, enabled or not', () => {
    const rule = shippedRule();
    for (const enabled of [true, false]) {
      const plan = planRuleSeeding({
        catalogue: catalogueOf(rule),
        rows: [stored({ version: null, enabled, severity: 'critical' })],
        recorded: new Set<string>(),
      });
      expect(plan, `enabled=${enabled}`).toEqual([
        expect.objectContaining({ action: 'record', version: rule.version }),
        { action: 'apply', rule },
      ]);
    }
  });

  it('only gives the version to a row with no version whose definition already matches', () => {
    const rule = shippedRule();
    const plan = planRuleSeeding({ catalogue: catalogueOf(rule), rows: [stored({ version: null, enabled: true })], recorded: new Set<string>() });
    expect(plan.map(a => a.action)).toEqual(['record', 'set-running']);
  });

  describe('the removed "Before versioning" pseudo-version (#246)', () => {
    const recordedLegacy = (id: string) => versionKey(id, LEGACY_PSEUDO_VERSION);

    it('moves an enabled and a disabled row on it to the shipped definition and version, and deletes its record', () => {
      const rule = shippedRule();
      for (const enabled of [true, false]) {
        const plan = planRuleSeeding({
          catalogue: catalogueOf(rule),
          rows: [stored({ version: LEGACY_PSEUDO_VERSION, enabled, severity: 'critical' })],
          recorded: new Set([recordedLegacy(rule.id)]),
        });
        expect(plan.map(a => a.action), `enabled=${enabled}`).toEqual(['record', 'apply', 'delete-recorded']);
        expect(plan).toContainEqual({ action: 'apply', rule });
        expect(plan).toContainEqual({ action: 'delete-recorded', ruleId: rule.id, version: LEGACY_PSEUDO_VERSION });
      }
    });

    it('does not move an enabled row on a real version', () => {
      const rule = shippedRule({ version: '1.1.0' });
      const plan = planRuleSeeding({
        catalogue: catalogueOf(rule), rows: [stored({ version: '1.0.0', enabled: true })], recorded: new Set([versionKey(rule.id, '1.0.0')]),
      });
      expect(plan.map(a => a.action)).toEqual(['record']);
    });

    it('keeps a rule no pack ships any more as it is, with no version, retired', () => {
      const other = shippedRule({ id: 'bbbbbbbb-0000-4000-8000-000000000002' });
      const row = stored({ version: LEGACY_PSEUDO_VERSION, enabled: true });
      const plan = planRuleSeeding({ catalogue: catalogueOf(other), rows: [row], recorded: new Set([recordedLegacy(row.id)]) });
      expect(plan).toEqual([
        { action: 'insert', rule: other },
        expect.objectContaining({ action: 'record', ruleId: other.id }),
        { action: 'clear-running', ruleId: row.id },
        { action: 'retire', ruleId: row.id },
        { action: 'delete-recorded', ruleId: row.id, version: LEGACY_PSEUDO_VERSION },
      ]);
    });

    it('clears the version of a rule whose pack could not be read, and does not retire it', () => {
      const row = stored({ version: LEGACY_PSEUDO_VERSION, pack: 'aprl-v2' });
      const plan = planRuleSeeding({
        catalogue: { rules: [], packsDirRead: true, unreadablePacks: ['aprl-v2'] }, rows: [row], recorded: new Set([recordedLegacy(row.id)]),
      });
      expect(plan).toEqual([
        { action: 'clear-running', ruleId: row.id },
        { action: 'delete-recorded', ruleId: row.id, version: LEGACY_PSEUDO_VERSION },
      ]);
    });

    it('gives a retirable rule with no version nothing but the Retired label', () => {
      const row = stored({ version: null, enabled: true });
      expect(planRuleSeeding({ catalogue: catalogueOf(), rows: [row], recorded: new Set() }))
        .toEqual([{ action: 'retire', ruleId: row.id }]);
    });

    it('forgets the version a custom rule was copied from, and only that', () => {
      const row = stored({ type: 'custom', pack: null, version: null, originRuleId: 'cccccccc-0000-4000-8000-000000000003', originVersion: LEGACY_PSEUDO_VERSION });
      expect(planRuleSeeding({ catalogue: catalogueOf(), rows: [row], recorded: new Set() }))
        .toEqual([{ action: 'clear-origin-version', ruleId: row.id }]);
      const real = stored({ type: 'custom', pack: null, version: null, originRuleId: 'cccccccc-0000-4000-8000-000000000003', originVersion: '1.0.0' });
      expect(planRuleSeeding({ catalogue: catalogueOf(), rows: [real], recorded: new Set() })).toEqual([]);
    });

    it('plans nothing on a second start', () => {
      const rule = shippedRule();
      expect(planRuleSeeding({ catalogue: catalogueOf(rule), rows: [stored({ version: rule.version, enabled: true })], recorded: new Set([versionKey(rule.id, rule.version)]) }))
        .toEqual([]);
    });
  });

  describe('the APRL query correction (#221)', () => {
    const APRL = { pack: 'aprl-v2', versionScheme: 'upstream-commit-date', version: APRL_QUERY_CORRECTION.version, enabled: false } as const;
    const correctedRule = (over: Parameters<typeof shippedRule>[0] = {}) =>
      shippedRule({ ...APRL, releaseNote: 'Changed: query.', definition: { rawKql: 'resources | where corrected == true' }, ...over });
    const input = (rule = correctedRule()) => ({ catalogue: catalogueOf(rule), recorded: new Set([versionKey(rule.id, rule.version)]) });
    const wrongRow = (over: Partial<StoredRuleRow> = {}) =>
      stored({ pack: 'aprl-v2', version: APRL_QUERY_CORRECTION.version, rawKql: 'resources | where wrong == true', ...over });

    it('corrects an enabled and a disabled row that run a different definition at the corrected version', () => {
      for (const enabled of [true, false]) {
        const plan = planRuleSeeding({ ...input(), rows: [wrongRow({ enabled })] });
        expect(plan, `enabled=${enabled}`).toEqual([{ action: 'correct', rule: correctedRule() }]);
      }
    });

    it('plans nothing for a row that already runs the shipped definition', () => {
      const rule = correctedRule();
      const row = wrongRow({ rawKql: rule.definition.rawKql });
      expect(planRuleSeeding({ ...input(rule), rows: [row] })).toEqual([]);
    });

    it('never corrects a RuleBeat Core rule, whatever its version', () => {
      const core = shippedRule({ version: '1.0.0', definition: { rawKql: 'resources | where corrected == true' } });
      const row = stored({ enabled: true, rawKql: 'resources | where wrong == true' });
      expect(planRuleSeeding({ catalogue: catalogueOf(core), rows: [row], recorded: new Set([versionKey(core.id, '1.0.0')]) })).toEqual([]);
      // Even one carrying the corrected version string: the scope is the pack and the version together.
      const coreAtVersion = shippedRule({ version: APRL_QUERY_CORRECTION.version, definition: { rawKql: 'resources | where corrected == true' } });
      expect(planRuleSeeding({
        catalogue: catalogueOf(coreAtVersion), rows: [{ ...row, version: APRL_QUERY_CORRECTION.version }],
        recorded: new Set([versionKey(coreAtVersion.id, APRL_QUERY_CORRECTION.version)]),
      })).toEqual([]);
    });

    it('never corrects a rule of another pack, or APRL at another version', () => {
      const other = correctedRule({ pack: 'other-pack' });
      expect(planRuleSeeding({ ...input(other), rows: [wrongRow({ pack: 'other-pack' })] })).toEqual([]);

      const later = correctedRule({ version: '2026-07-01T00:00:00Z' });
      expect(planRuleSeeding({ ...input(later), rows: [wrongRow({ version: '2026-07-01T00:00:00Z' })] })).toEqual([]);
    });

    it('does not reach a row with no version, which the first-versioning path handles', () => {
      const plan = planRuleSeeding({ catalogue: catalogueOf(correctedRule()), rows: [wrongRow({ version: null, enabled: true })], recorded: new Set() });
      expect(plan.map(a => a.action)).not.toContain('correct');
    });

    it('does not correct a rule an admin converted to a custom rule', () => {
      const row = wrongRow({ originRuleId: 'aaaaaaaa-0000-4000-8000-000000000001' });
      expect(planRuleSeeding({ ...input(), rows: [row] })).toEqual([]);
    });
  });

  it('moves a disabled rule that runs an older shipped version, and only then', () => {
    const newer = shippedRule({ version: '1.1.0' });
    const input = { catalogue: catalogueOf(newer), recorded: new Set<string>() };
    expect(planRuleSeeding({ ...input, rows: [stored({ enabled: false })] }).map(a => a.action)).toEqual(['record', 'apply']);
    expect(planRuleSeeding({ ...input, rows: [stored({ enabled: true })] }).map(a => a.action)).toEqual(['record']);
  });
});
