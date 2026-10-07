/**
 * Ticket #165 (spec #152, ADR 0004): how the Library finds rules with a newer recorded version and
 * retired rules, and how a duplicate says where it came from.
 *
 * The first block drives the real startup seeder (SQLite or Postgres, whichever this run uses) through
 * two "releases" and reads the result back through the same loader the Library page calls. The rest
 * are the pure helpers the Library list and the rule view are built on; the client components hold no
 * logic of their own beyond calling them.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dbReady, pgDb, rawSqlite } from '@/lib/db/client';
import { dbKind } from '@/lib/db/backend';
import { runSeeds } from '@/lib/db/migrate';
import { seedPg } from '@/lib/db/pg/seeds';
import { loadRecordedVersions } from '@/lib/db/recorded-versions';
import { createRule, duplicateRule, loadRules } from '@/lib/rules';
import {
  convertedOriginText, describeOrigin, matchesVersionFilter, newerVersionsByRule, retiredMessage, versionLabel,
  type RecordedVersion,
} from '@/lib/rule-version-markers';
import type { Rule } from '@/lib/types';
import type { ShippedCatalogue } from '@/lib/shipped-catalogue';
import { catalogueOf, shippedRule } from '../helpers/catalogue';

const dataDir = mkdtempSync(join(tmpdir(), 'rb-markers-'));

async function seed(catalogue: ShippedCatalogue): Promise<void> {
  await dbReady;
  if (dbKind === 'pg') await seedPg(pgDb!, dataDir, { skipOwnerBootstrap: true, catalogue });
  else runSeeds(rawSqlite!, dataDir, { skipOwnerBootstrap: true, catalogue });
}

const APRL_V1 = '2026-06-08T13:06:47Z';
const APRL_V2 = '2026-09-14T08:30:00Z';

describe('after a release that changes shipped rules', () => {
  const changed = (version: string, name: string) => shippedRule({ id: 'marker-changed', version, definition: { name } });
  const aprl = (version: string, name: string) => shippedRule({
    id: 'marker-aprl', pack: 'aprl-v2', versionScheme: 'upstream-commit-date', version, enabled: true, definition: { name },
  });

  it('marks exactly the rules that have a recorded version newer than the one they run, and the retired ones', async () => {
    await seed(catalogueOf(
      changed('1.0.0', 'Changed rule'), aprl(APRL_V1, 'Aprl rule'),
      shippedRule({ id: 'marker-same', definition: { name: 'Same rule' } }),
      shippedRule({ id: 'marker-gone', definition: { name: 'Gone rule' } }),
    ));
    await seed(catalogueOf(
      changed('1.1.0', 'Changed rule v2'), aprl(APRL_V2, 'Aprl rule v2'),
      shippedRule({ id: 'marker-same', definition: { name: 'Same rule' } }),
    ));

    const rules = await loadRules();
    const recorded = await loadRecordedVersions();
    const newer = newerVersionsByRule(rules, recorded);

    expect(newer['marker-changed']).toBe('1.1.0');
    expect(newer['marker-aprl']).toBe(APRL_V2);
    expect(newer['marker-same']).toBeUndefined();
    expect(newer['marker-gone']).toBeUndefined();
    // The enabled rules still run what they ran: the marker is the only sign of the new version.
    expect(rules.find(r => r.id === 'marker-changed')).toMatchObject({ name: 'Changed rule', version: '1.0.0' });
    expect(rules.find(r => r.id === 'marker-gone')?.retiredAt).toBeTruthy();
    expect(rules.find(r => r.id === 'marker-same')?.retiredAt).toBeUndefined();
  });

  it('stops marking a rule once its newest version is the one it runs', async () => {
    // A disabled rule moves to the newest version on upgrade, so nothing is left to announce.
    await seed(catalogueOf(changed('1.1.0', 'Changed rule v2'), aprl(APRL_V2, 'Aprl rule v2')));
    const { setRulesEnabled } = await import('@/lib/rules');
    await setRulesEnabled(['marker-changed'], false);
    await seed(catalogueOf(changed('1.2.0', 'Changed rule v3'), aprl(APRL_V2, 'Aprl rule v2')));

    const rules = await loadRules();
    const newer = newerVersionsByRule(rules, await loadRecordedVersions());
    expect(rules.find(r => r.id === 'marker-changed')?.version).toBe('1.2.0');
    expect(newer['marker-changed']).toBeUndefined();
  });
});

describe('a duplicate made after a release', () => {
  it('records where it came from, and the origin shows the newer version once one is recorded', async () => {
    const v = (version: string, name: string) => shippedRule({ id: 'origin-src', version, definition: { name } });
    await seed(catalogueOf(v('1.0.0', 'Origin rule')));
    const copy = (await duplicateRule('origin-src'))!;

    // Nothing newer yet.
    let rules = await loadRules();
    let recorded = await loadRecordedVersions();
    expect(describeOrigin(rules.find(r => r.id === copy.id)!, rules, recorded)).toEqual({
      kind: 'duplicate', originRuleId: 'origin-src', originName: 'Origin rule', version: '1.0.0', hasNewerVersion: false,
    });

    await seed(catalogueOf(v('1.1.0', 'Origin rule v2')));
    rules = await loadRules();
    recorded = await loadRecordedVersions();
    expect(describeOrigin(rules.find(r => r.id === copy.id)!, rules, recorded)).toMatchObject({
      originName: 'Origin rule', version: '1.0.0', hasNewerVersion: true,
    });
  });

  it('is not guessed for a custom rule made without an origin', async () => {
    const made = await createRule({
      id: 'plain-custom', name: 'Plain custom rule', description: '', category: 'security', severity: 'low',
      enabled: false, type: 'custom', scope: { level: 'resource' }, resourceTypes: [], conditions: [],
    } as Rule);
    expect(made.ok).toBe(true);
    const rules = await loadRules();
    expect(describeOrigin(rules.find(r => r.id === 'plain-custom')!, rules, await loadRecordedVersions())).toBeNull();
  });
});

function rec(ruleId: string, version: string, sortKey: string): RecordedVersion {
  return { ruleId, version, sortKey };
}
function rule(over: Partial<Rule>): Rule {
  return {
    id: 'r', name: 'R', description: '', category: 'security', severity: 'low', enabled: true, type: 'builtin',
    scope: { level: 'resource' }, resourceTypes: [], conditions: [], ...over,
  } as Rule;
}

describe('newerVersionsByRule', () => {
  it('orders by the recorded sort key, so 1.10.0 is newer than 1.9.0 and an APRL timestamp orders as time', () => {
    const rules = [rule({ id: 'a', version: '1.9.0' }), rule({ id: 'b', version: APRL_V1 })];
    const recorded = [
      rec('a', '1.9.0', '0000000001.0000000009.0000000000'), rec('a', '1.10.0', '0000000001.0000000010.0000000000'),
      rec('b', APRL_V1, '2026-06-08T13:06:47.000Z'), rec('b', '2026-06-08T14:00:00Z', '2026-06-08T14:00:00.000Z'),
    ];
    expect(newerVersionsByRule(rules, recorded)).toEqual({ a: '1.10.0', b: '2026-06-08T14:00:00Z' });
  });

  it('names the newest of several newer versions', () => {
    const recorded = [rec('a', '1.0.0', 'k1'), rec('a', '1.2.0', 'k3'), rec('a', '1.1.0', 'k2')];
    expect(newerVersionsByRule([rule({ id: 'a', version: '1.0.0' })], recorded)).toEqual({ a: '1.2.0' });
  });

  it('counts a rule left on "Before versioning" as having a newer version when the shipped one is recorded', () => {
    const recorded = [rec('a', 'before-versioning', ''), rec('a', '1.0.0', 'k1')];
    expect(newerVersionsByRule([rule({ id: 'a', version: 'before-versioning' })], recorded)).toEqual({ a: '1.0.0' });
  });

  it('says nothing about a custom rule, or a rule whose running version was never recorded', () => {
    const recorded = [rec('c', '1.0.0', 'k1'), rec('c', '1.1.0', 'k2'), rec('x', '1.1.0', 'k2')];
    expect(newerVersionsByRule([rule({ id: 'c', type: 'custom', version: undefined }), rule({ id: 'x', version: '1.0.0' })], recorded)).toEqual({});
  });
});

describe('matchesVersionFilter', () => {
  const newer = { a: '1.1.0' };
  const plain = rule({ id: 'b' });
  const marked = rule({ id: 'a' });
  const retired = rule({ id: 'c', retiredAt: '2026-10-01T00:00:00Z' });

  it('lets everything through when nothing is selected', () => {
    for (const r of [plain, marked, retired]) expect(matchesVersionFilter(r, newer, new Set())).toBe(true);
  });

  it('keeps only rules with a new version for "new-version" and only retired rules for "retired"', () => {
    expect([plain, marked, retired].filter(r => matchesVersionFilter(r, newer, new Set(['new-version']))).map(r => r.id)).toEqual(['a']);
    expect([plain, marked, retired].filter(r => matchesVersionFilter(r, newer, new Set(['retired']))).map(r => r.id)).toEqual(['c']);
  });

  it('keeps a rule matching either selected marker', () => {
    expect([plain, marked, retired].filter(r => matchesVersionFilter(r, newer, new Set(['new-version', 'retired']))).map(r => r.id)).toEqual(['a', 'c']);
  });
});

describe('the words', () => {
  it('words a retired rule the same for every pack', () => {
    expect(retiredMessage('APRL v2')).toBe('Retired. APRL v2 no longer ships this rule.');
    expect(retiredMessage('RuleBeat Core')).toBe('Retired. RuleBeat Core no longer ships this rule.');
  });

  it('shows semver as is, a commit-date version as its date and the first upgrade as "Before versioning"', () => {
    expect(versionLabel('1.2.0')).toBe('1.2.0');
    expect(versionLabel('2026-06-08T13:06:47Z')).toBe('2026-06-08');
    expect(versionLabel('before-versioning')).toBe('Before versioning');
  });

  it('words a converted rule "at" a real version, and plainly when it ran its stored definition', () => {
    expect(convertedOriginText('1.0.0')).toBe('Converted from the built-in rule at 1.0.0.');
    expect(convertedOriginText('2026-06-08T13:06:47Z')).toBe('Converted from the built-in rule at 2026-06-08.');
    expect(convertedOriginText('before-versioning')).toBe('Converted from the built-in rule.');
    expect(convertedOriginText(null)).toBe('Converted from the built-in rule.');
  });
});

describe('describeOrigin', () => {
  const origin = rule({ id: 'o', name: 'Origin', version: '1.0.0' });
  const recorded = [rec('o', '1.0.0', 'k1'), rec('o', '1.1.0', 'k2')];

  it('names the origin and the version the copy was made from', () => {
    const copy = rule({ id: 'c', type: 'custom', originRuleId: 'o', originVersion: APRL_V1 });
    expect(describeOrigin(copy, [origin, copy], [rec('o', APRL_V1, '2026-06-08T13:06:47.000Z')])).toMatchObject({
      kind: 'duplicate', originName: 'Origin', version: APRL_V1, hasNewerVersion: false,
    });
  });

  it('flags a newer version only when the origin has one recorded beyond the version copied', () => {
    const copy = rule({ id: 'c', type: 'custom', originRuleId: 'o', originVersion: '1.0.0' });
    expect(describeOrigin(copy, [origin, copy], recorded)).toMatchObject({ hasNewerVersion: true });
    const current = rule({ id: 'd', type: 'custom', originRuleId: 'o', originVersion: '1.1.0' });
    expect(describeOrigin(current, [origin, current], recorded)).toMatchObject({ hasNewerVersion: false });
  });

  it('still reports the origin when that rule no longer exists, without a name or a hint', () => {
    const copy = rule({ id: 'c', type: 'custom', originRuleId: 'gone', originVersion: '1.0.0' });
    expect(describeOrigin(copy, [copy], recorded)).toEqual({
      kind: 'duplicate', originRuleId: 'gone', originName: null, version: '1.0.0', hasNewerVersion: false,
    });
  });

  it('calls an Identity built-in that was converted in place converted, not duplicated, and offers no newer version', () => {
    const converted = rule({ id: 'cred:app-secret-expiring', type: 'custom', originRuleId: 'cred:app-secret-expiring', originVersion: '1.0.0' });
    expect(describeOrigin(converted, [converted], [rec('cred:app-secret-expiring', '1.0.0', 'k1'), rec('cred:app-secret-expiring', '1.1.0', 'k2')]))
      .toEqual({ kind: 'converted', version: '1.0.0', hasNewerVersion: false });
  });

  it('has nothing to say about a rule that is not custom or has no origin', () => {
    expect(describeOrigin(origin, [origin], recorded)).toBeNull();
    expect(describeOrigin(rule({ id: 'p', type: 'custom' }), [origin], recorded)).toBeNull();
  });
});
