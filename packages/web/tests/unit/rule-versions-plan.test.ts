/**
 * The pure steps of rule seeding (ticket #163): version ordering, definition comparison, and the
 * one guard the database-level tests cannot reach because no real version string sorts after
 * "before-versioning".
 */
import { describe, expect, it } from 'vitest';
import {
  BEFORE_VERSIONING, canonicalDefinition, compareVersions, planRuleSeeding, sameDefinition, versionKey, versionSortKey,
  type StoredRuleRow,
} from '@/lib/rule-versions';
import { catalogueOf, shippedRule } from '../helpers/catalogue';

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

  it('sorts "Before versioning" before every other key, under every scheme', () => {
    const before = versionSortKey('semver', BEFORE_VERSIONING);
    const others = [
      versionSortKey('semver', '0.0.0'),
      versionSortKey('upstream-commit-date', '1970-01-01T00:00:00Z'),
      versionSortKey('upstream-release', '0'),
      versionSortKey('upstream-release', '!'),
    ];
    for (const key of others) expect(before < key, key).toBe(true);
    expect(versionSortKey('upstream-commit-date', BEFORE_VERSIONING)).toBe(before);
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
      pack: 'rulebeat-core', version: '1.0.0', retiredAt: null, originRuleId: null,
      ...over,
    };
  }

  it('moves a disabled rule running "Before versioning" to the newest shipped version, whatever it sorts as, and leaves an enabled one', () => {
    const newer = shippedRule({ versionScheme: 'upstream-release', version: 'zeta' });
    const input = { catalogue: catalogueOf(newer), recorded: new Set([versionKey(newer.id, BEFORE_VERSIONING)]) };
    expect(planRuleSeeding({ ...input, rows: [stored({ version: BEFORE_VERSIONING, enabled: false })] }).map(a => a.action)).toEqual(['record', 'apply']);
    expect(planRuleSeeding({ ...input, rows: [stored({ version: BEFORE_VERSIONING, enabled: true })] }).map(a => a.action)).toEqual(['record']);
  });

  it('records a version with the sort key its scheme gives it, and "Before versioning" with the lowest key', () => {
    const rule = shippedRule({ versionScheme: 'upstream-commit-date', version: '2026-06-08T13:06:47Z' });
    const plan = planRuleSeeding({
      catalogue: catalogueOf(rule),
      rows: [stored({ version: null, enabled: true, severity: 'critical' })],
      recorded: new Set<string>(),
    });
    const recordedKeys = Object.fromEntries(
      plan.flatMap(a => (a.action === 'record' ? [[a.version, a.sortKey]] : [])),
    );
    expect(recordedKeys).toEqual({
      '2026-06-08T13:06:47Z': versionSortKey('upstream-commit-date', '2026-06-08T13:06:47Z'),
      [BEFORE_VERSIONING]: versionSortKey('upstream-commit-date', BEFORE_VERSIONING),
    });
  });

  it('on the first upgrade keeps a differing stored definition as "Before versioning", then moves a disabled row to the shipped version', () => {
    const rule = shippedRule();
    const plan = planRuleSeeding({
      catalogue: catalogueOf(rule),
      rows: [stored({ version: null, enabled: false, severity: 'critical' })],
      recorded: new Set<string>(),
    });
    expect(plan.map(a => a.action)).toEqual(['record', 'record', 'apply']);
    expect(plan.filter(a => a.action === 'record').map(a => a.action === 'record' && a.version)).toEqual([rule.version, BEFORE_VERSIONING]);
  });

  it('on the first upgrade keeps a differing enabled row running as "Before versioning"', () => {
    const plan = planRuleSeeding({
      catalogue: catalogueOf(shippedRule()),
      rows: [stored({ version: null, enabled: true, severity: 'critical' })],
      recorded: new Set<string>(),
    });
    expect(plan.map(a => a.action)).toEqual(['record', 'record', 'set-running']);
  });

  it('moves a disabled rule that runs an older shipped version, and only then', () => {
    const newer = shippedRule({ version: '1.1.0' });
    const input = { catalogue: catalogueOf(newer), recorded: new Set<string>() };
    expect(planRuleSeeding({ ...input, rows: [stored({ enabled: false })] }).map(a => a.action)).toEqual(['record', 'apply']);
    expect(planRuleSeeding({ ...input, rows: [stored({ enabled: true })] }).map(a => a.action)).toEqual(['record']);
  });
});
