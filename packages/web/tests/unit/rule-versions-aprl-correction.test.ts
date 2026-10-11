/**
 * Ticket #221 on SQLite: the first start after the upgrade corrects the installed APRL rules that
 * ran another recommendation's query, enabled ones included, and removes the findings that query
 * produced. Nothing else changes.
 *
 * A database is seeded from the pack as it used to ship (tests/fixtures/aprl-v2-before-221.json),
 * the admin's choices and findings are added, then it is seeded again with the committed pack. What
 * must change and what must not are both asserted by content. The Postgres twin is in
 * pg-rule-versions.test.ts.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase, runMigrations, runSeeds } from '@/lib/db/migrate';
import type { ShippedCatalogue } from '@/lib/shipped-catalogue';
import {
  CHANGED, DUMP_SQL, UNCHANGED, adminChoicesSql, committedCatalogue, committedPackEntries, coreRuleId,
  oldCatalogue, oldPackEntries, populationSql, type DumpTable,
} from '../helpers/aprl-correction';

const APRL_VERSION = '2026-06-08T13:06:47Z';
const ALL = [...CHANGED, ...UNCHANGED];

let sqlite: Database.Database;
let dir: string;
let core: string;

const seed = (catalogue: ShippedCatalogue) => runSeeds(sqlite, dir, { skipOwnerBootstrap: true, catalogue });
const dump = (table: DumpTable) => sqlite.prepare(DUMP_SQL[table]).all() as Array<Record<string, unknown>>;
const dumpAll = () => Object.fromEntries((Object.keys(DUMP_SQL) as DumpTable[]).map(t => [t, dump(t)]));
const rule = (id: string) => sqlite.prepare(`SELECT * FROM rules WHERE id = ?`).get(id) as Record<string, unknown>;
const where = (rows: Array<Record<string, unknown>>, ruleId: string) => rows.filter(r => r.rule_id === ruleId);
const shipped = (id: string) => committedPackEntries().find(r => r.id === id)!;

let before: ReturnType<typeof dumpAll>;
let after: ReturnType<typeof dumpAll>;
let beforeSecondStart: ReturnType<typeof dumpAll>;
let afterSecondStart: ReturnType<typeof dumpAll>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'rb-aprl-correction-'));
  sqlite = openDatabase(join(dir, 'rulebeat.db'));
  runMigrations(sqlite);

  const old = oldCatalogue();
  core = coreRuleId(old);
  seed(old);
  for (const statement of [...adminChoicesSql(), ...populationSql(core)]) sqlite.exec(statement);
  before = dumpAll();

  seed(committedCatalogue());
  after = dumpAll();

  // A scan after the upgrade finds something on a corrected rule; a second start must not remove it.
  sqlite.exec(`INSERT INTO findings (fingerprint, rule_id, category, severity, subscription_id, title, status, first_seen_at, last_seen_at, times_seen)
    VALUES ('fp-new-scan', '${CHANGED[0]}', 'reliability', 'high', 'sub-1', 'A real finding', 'active', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 1)`);
  beforeSecondStart = dumpAll();
  seed(committedCatalogue());
  afterSecondStart = dumpAll();
});

describe('the database before the upgrade', () => {
  it('holds the old, wrong query on the rules the fix corrects, and the right one on the others', () => {
    const old = new Map(oldPackEntries().map(r => [r.id, r.rawKql]));
    for (const id of CHANGED) {
      expect(before.rules.find(r => r.id === id)!.raw_kql, id).not.toBe(shipped(id).rawKql);
    }
    for (const id of UNCHANGED) {
      expect(old.get(id), id).toBe(shipped(id).rawKql);
      expect(before.rules.find(r => r.id === id)!.raw_kql, id).toBe(shipped(id).rawKql);
    }
    expect(before.findings.length).toBe(6);
  });
});

describe('the first start after the upgrade', () => {
  it('rewrites every wrong query to the shipped one, whether the rule is enabled or not', () => {
    for (const id of CHANGED) {
      expect(rule(id).raw_kql, id).toBe(shipped(id).rawKql);
      expect(JSON.parse(rule(id).resource_types as string), id).toEqual((committedPackEntries().find(r => r.id === id) as unknown as { resourceTypes: string[] }).resourceTypes);
    }
    const enabled = CHANGED.filter(id => rule(id).enabled === 1);
    const disabled = CHANGED.filter(id => rule(id).enabled === 0);
    expect(enabled.length).toBeGreaterThan(0);
    expect(disabled.length).toBeGreaterThan(0);
  });

  it('leaves the enabled state, tags, version and retirement of every rule as the admin left them', () => {
    const kept = (rows: Array<Record<string, unknown>>) =>
      rows.map(r => [r.id, r.enabled, r.tags, r.version, r.retired_at, r.type, r.pack]);
    const beforeIds = new Set(before.rules.map(r => r.id));
    expect(kept(after.rules.filter(r => beforeIds.has(r.id)))).toEqual(kept(before.rules));
    expect(CHANGED.map(id => rule(id).enabled)).toEqual([1, 0, 1, 0, 0]);
    expect(CHANGED.map(id => rule(id).tags)).toEqual(['["mine"]', '["mine"]', null, null, null]);
  });

  it('leaves a rule whose query was already its own exactly as it was', () => {
    for (const id of UNCHANGED) {
      expect(after.rules.find(r => r.id === id), id).toEqual(before.rules.find(r => r.id === id));
    }
  });

  it('holds the corrected definition and the shipped note in the one recorded version, adding none', () => {
    for (const id of ALL) {
      const versions = after.rule_versions.filter(v => v.rule_id === id);
      expect(versions.map(v => v.version), id).toEqual([APRL_VERSION]);
    }
    for (const id of CHANGED) {
      const recorded = after.rule_versions.find(v => v.rule_id === id)!;
      expect(JSON.parse(recorded.definition as string).rawKql, id).toBe(shipped(id).rawKql);
      expect(recorded.release_note, id).toBe(shipped(id).releaseNote);
      expect(recorded.first_seen_at, id).toBe(before.rule_versions.find(v => v.rule_id === id)!.first_seen_at);
    }
    for (const id of UNCHANGED) {
      expect(after.rule_versions.find(v => v.rule_id === id), id).toEqual(before.rule_versions.find(v => v.rule_id === id));
    }
  });

  it('removes every finding the wrong query produced, open and fixed, with their rows, events and columns', () => {
    for (const id of CHANGED) {
      expect(after.findings.filter(r => r.rule_id === id), id).toEqual([]);
      expect(where(after.finding_events, id), id).toEqual([]);
      expect(where(after.column_catalogue, id), id).toEqual([]);
    }
    const corrected = new Set(before.findings.filter(f => (CHANGED as readonly string[]).includes(f.rule_id as string)).map(f => f.fingerprint));
    expect(corrected.size).toBe(4);
    expect(after.finding_rows.filter(r => corrected.has(r.fingerprint))).toEqual([]);
  });

  it('leaves the findings of every other rule exactly as they were', () => {
    const others = (rows: Array<Record<string, unknown>>) => rows.filter(r => !(CHANGED as readonly string[]).includes(r.rule_id as string));
    expect(others(after.findings)).toEqual(others(before.findings));
    expect(others(after.finding_events)).toEqual(others(before.finding_events));
    expect(others(after.column_catalogue)).toEqual(others(before.column_catalogue));
    expect(after.finding_rows.filter(r => ['fp-u-open', 'fp-core-open'].includes(r.fingerprint as string)))
      .toEqual(before.finding_rows.filter(r => ['fp-u-open', 'fp-core-open'].includes(r.fingerprint as string)));
    expect(others(after.findings).map(f => f.rule_id)).toContain(core);
  });

  it('keeps every suppression, and does not touch posture snapshots or Run History records', () => {
    expect(after.suppressions).toEqual(before.suppressions);
    expect(after.suppressions.length).toBe(2);
    expect(after.posture_snapshots).toEqual(before.posture_snapshots);
    expect(after.scan_findings).toEqual(before.scan_findings);
  });
});

describe('the second start', () => {
  it('changes no row in any table, and keeps what a scan found on a corrected rule in between', () => {
    expect(afterSecondStart).toEqual(beforeSecondStart);
    expect(afterSecondStart.findings.map(f => f.fingerprint)).toContain('fp-new-scan');
  });
});
