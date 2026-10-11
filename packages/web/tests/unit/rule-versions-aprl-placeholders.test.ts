/**
 * Ticket #222 on SQLite: the pack no longer ships the two APRL rules whose query is only
 * `// under-development`, so the first start after the upgrade marks an installed copy retired.
 * Nothing else about it changes: it stays enabled or disabled as the admin left it, keeps its tags,
 * version and query, and its findings and suppressions stay.
 *
 * A database is seeded from the pack as it shipped (tests/fixtures/aprl-v2-before-222.json), the
 * admin's choices and findings are added, then it is seeded again with the committed pack. The
 * Postgres twin is in pg-rule-versions.test.ts.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase, runMigrations, runSeeds } from '@/lib/db/migrate';
import type { ShippedCatalogue } from '@/lib/shipped-catalogue';
import { committedCatalogue } from '../helpers/aprl-correction';
import {
  DISABLED_PLACEHOLDER, ENABLED_PLACEHOLDER, KEPT_SQL, PLACEHOLDERS, RULE_KEPT_COLUMNS, oldPlaceholderCatalogue,
  placeholderChoicesSql, placeholderEntries, placeholderPopulationSql, type KeptTable,
} from '../helpers/aprl-placeholders';

let sqlite: Database.Database;
let dir: string;

const seed = (catalogue: ShippedCatalogue) => runSeeds(sqlite, dir, { skipOwnerBootstrap: true, catalogue });
const dumpKept = () => Object.fromEntries((Object.keys(KEPT_SQL) as KeptTable[]).map(t => [t, sqlite.prepare(KEPT_SQL[t]).all()]));
const allRules = () => sqlite.prepare(`SELECT * FROM rules ORDER BY id`).all() as Array<Record<string, unknown>>;
const allVersions = () => sqlite.prepare(`SELECT * FROM rule_versions ORDER BY rule_id, version`).all();
const rule = (rules: Array<Record<string, unknown>>, id: string) => rules.find(r => r.id === id)!;
const kept = (r: Record<string, unknown>) => RULE_KEPT_COLUMNS.map(c => r[c]);

let rulesBefore: Array<Record<string, unknown>>;
let rulesAfter: Array<Record<string, unknown>>;
let keptBefore: ReturnType<typeof dumpKept>;
let keptAfter: ReturnType<typeof dumpKept>;
let afterFirst: { rules: unknown; versions: unknown; kept: unknown };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'rb-aprl-placeholders-'));
  sqlite = openDatabase(join(dir, 'rulebeat.db'));
  runMigrations(sqlite);

  const old = oldPlaceholderCatalogue();
  seed(old);
  for (const statement of [...placeholderChoicesSql(), ...placeholderPopulationSql()]) sqlite.exec(statement);
  rulesBefore = allRules();
  keptBefore = dumpKept();

  seed(committedCatalogue());
  rulesAfter = allRules();
  keptAfter = dumpKept();
  afterFirst = { rules: rulesAfter, versions: allVersions(), kept: keptAfter };

  seed(committedCatalogue());
});

describe('the database before the upgrade', () => {
  it('holds both placeholder rules as shipped, one enabled and one disabled, with findings', () => {
    for (const entry of placeholderEntries()) expect(rule(rulesBefore, entry.id).raw_kql, entry.id).toBe('// under-development');
    expect(rule(rulesBefore, ENABLED_PLACEHOLDER).enabled).toBe(1);
    expect(rule(rulesBefore, DISABLED_PLACEHOLDER).enabled).toBe(0);
    for (const id of PLACEHOLDERS) expect(rule(rulesBefore, id).retired_at, id).toBeNull();
    expect(keptBefore.findings).toHaveLength(3);
    expect(keptBefore.suppressions).toHaveLength(2);
  });
});

describe('the first start after the upgrade', () => {
  it('marks both placeholder rules retired', () => {
    for (const id of PLACEHOLDERS) expect(rule(rulesAfter, id).retired_at, id).not.toBeNull();
  });

  it('leaves enabled state, tags, version, query, type and pack of each as the admin left them', () => {
    for (const id of PLACEHOLDERS) expect(kept(rule(rulesAfter, id)), id).toEqual(kept(rule(rulesBefore, id)));
    expect(PLACEHOLDERS.map(id => rule(rulesAfter, id).enabled)).toEqual([1, 0]);
    expect(PLACEHOLDERS.map(id => rule(rulesAfter, id).tags)).toEqual(['["mine"]', null]);
  });

  it('retires nothing else: no other rule the old build shipped has a retirement', () => {
    const retired = rulesAfter.filter(r => r.retired_at !== null).map(r => r.id);
    expect(retired.sort()).toEqual([...PLACEHOLDERS].sort());
  });

  it('keeps every finding, row, event and suppression exactly as it was', () => {
    expect(keptAfter).toEqual(keptBefore);
    expect(keptAfter.findings).toHaveLength(3);
    expect(keptAfter.finding_rows).toHaveLength(3);
    expect(keptAfter.finding_events).toHaveLength(3);
    expect(keptAfter.suppressions).toHaveLength(2);
  });
});

describe('the second start', () => {
  it('changes no row in the rules, their versions, or the findings and suppressions', () => {
    expect(allRules()).toEqual(afterFirst.rules);
    expect(allVersions()).toEqual(afterFirst.versions);
    expect(dumpKept()).toEqual(afterFirst.kept);
  });
});
