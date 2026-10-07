/**
 * Ticket #163 · upgrading a real customer database must not change what any rule runs.
 *
 * Every sample shape is put through the product's own migrations, then the seeder, with the real
 * shipped catalogue (Core plus the committed APRL pack). Everything the seeder is forbidden to touch
 * is compared as content before and after: each enabled rule's definition columns, every rule's
 * enabled state and tags, and the findings (with their ages) and suppressions that hang off it. A
 * disabled rule is the one thing allowed to change what it runs: it moves to the shipped version,
 * with the old definition kept as "Before versioning".
 *
 * The "before" snapshot is taken after `runMigrations()` and before `runSeeds()`, because the older
 * migrations legitimately rename rule ids and tables; what this ticket changes is the seeder, and
 * the seeder is what is held to "no definition changes".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase, runMigrations, runSeeds } from '@/lib/db/migrate';
import { versionKey } from '@/lib/rule-versions';
import { loadShippedCatalogue } from '@/lib/shipped-catalogue';
import { SHAPES } from '../fixtures/db-shapes';
import { makeSample, open } from '../fixtures/upgrade';
import { rowsIfPresent } from '../fixtures/inspect';

const REAL_DATA_DIR = join(resolve(__dirname, '..', '..'), 'data');
const APRL_VERSION = '2026-06-08T13:06:47Z';

/** What an upgrade may never change for a rule that already exists. */
const UNTOUCHED_COLUMNS = [
  'name', 'description', 'category', 'severity', 'enabled', 'tags',
  'scope', 'resource_types', 'conditions', 'condition_groups', 'visual_query', 'project_columns',
  'raw_kql', 'query_backend', 'kind', 'graph_query', 'logs_query',
] as const;

type Row = Record<string, unknown>;

function ruleSnapshot(sqlite: Database): Map<string, Row> {
  const snapshot = new Map<string, Row>();
  for (const row of rowsIfPresent(sqlite, 'rules')) {
    snapshot.set(String(row.id), Object.fromEntries(UNTOUCHED_COLUMNS.map(c => [c, row[c] ?? null])));
  }
  return snapshot;
}

function withRealPacks(dataDir: string): void {
  cpSync(join(REAL_DATA_DIR, 'packs'), join(dataDir, 'packs'), { recursive: true });
}

function versionsOf(sqlite: Database): Set<string> {
  return new Set(rowsIfPresent(sqlite, 'rule_versions').map(r => versionKey(String(r.rule_id), String(r.version))));
}

describe.each(SHAPES)('#163 · %s · an upgrade leaves what the rules run alone', shape => {
  let sqlite: Database;
  let before: { rules: Map<string, Row>; findings: Row[]; suppressions: Row[] };
  let after: { rules: Map<string, Row>; findings: Row[]; suppressions: Row[] };

  beforeAll(() => {
    const sample = makeSample(shape);
    withRealPacks(sample.dataDir);

    const db = openDatabase(sample.file);
    try {
      runMigrations(db);
      before = {
        rules: ruleSnapshot(db),
        findings: rowsIfPresent(db, 'findings'),
        suppressions: rowsIfPresent(db, 'suppressions'),
      };
      runSeeds(db, sample.dataDir);
    } finally {
      db.close();
    }

    sqlite = open(sample.file);
    after = {
      rules: ruleSnapshot(sqlite),
      findings: rowsIfPresent(sqlite, 'findings'),
      suppressions: rowsIfPresent(sqlite, 'suppressions'),
    };
  });
  afterAll(() => sqlite.close());

  // `current` is an empty file (a brand-new install), so it has nothing to compare; the fresh-install
  // test below covers it. Every other shape holds rules, and the comparisons must not be vacuous.
  it('has rules to compare, so the checks below are not vacuous', () => {
    if (shape === 'current') expect(before.rules.size).toBe(0);
    else expect(before.rules.size).toBeGreaterThan(0);
  });

  it('changes no definition of an enabled rule, and never an enabled state or tags', () => {
    for (const [id, was] of before.rules) {
      const now = after.rules.get(id);
      expect(now, `rule ${id} vanished`).toBeDefined();
      expect(now!.enabled, `rule ${id} enabled state`).toEqual(was.enabled);
      expect(now!.tags, `rule ${id} tags`).toEqual(was.tags);
      if (was.enabled) expect(now, `enabled rule ${id} changed what it runs`).toEqual(was);
    }
  });

  it('moves a disabled rule to its shipped version, and keeps what it ran as "before-versioning"', () => {
    const shipped = new Map(loadShippedCatalogue(REAL_DATA_DIR).rules.map(r => [r.id, r]));
    const running = new Map(rowsIfPresent(sqlite, 'rules').map(r => [String(r.id), r]));
    const recorded = new Map(rowsIfPresent(sqlite, 'rule_versions').map(r => [versionKey(String(r.rule_id), String(r.version)), r]));
    let moved = 0;
    for (const [id, was] of before.rules) {
      const now = after.rules.get(id)!;
      if (JSON.stringify(now) === JSON.stringify(was)) continue;
      moved++;
      const rule = shipped.get(id);
      expect(was.enabled, `rule ${id} changed while enabled`).toBeFalsy();
      expect(rule, `rule ${id} changed but nothing ships it`).toBeDefined();
      expect(running.get(id)!.version, `rule ${id} runs ${running.get(id)!.version}`).toBe(rule!.version);
      expect(recorded.has(versionKey(id, 'before-versioning')), `rule ${id} lost what it ran before`).toBe(true);
      expect(recorded.has(versionKey(id, rule!.version)), `rule ${id} shipped version`).toBe(true);
    }
    if (shape === 'legacy-rules') expect(moved, 'the legacy-rules shape stores disabled rules whose definitions differ').toBeGreaterThan(0);
  });

  it('keeps every finding and its age, and every suppression', () => {
    expect(after.findings).toEqual(before.findings);
    expect(after.suppressions).toEqual(before.suppressions);
  });

  it('records the version every shipped rule ships under, Core at 1.0.0 and APRL at the upstream commit time', () => {
    const catalogue = loadShippedCatalogue(REAL_DATA_DIR);
    const recorded = versionsOf(sqlite);
    const core = catalogue.rules.filter(r => r.pack === 'rulebeat-core');
    const aprl = catalogue.rules.filter(r => r.pack === 'aprl-v2');
    expect(core.length).toBeGreaterThan(0);
    expect(aprl).toHaveLength(143);
    for (const r of core) expect(recorded.has(versionKey(r.id, '1.0.0')), `${r.id} 1.0.0`).toBe(true);
    for (const r of aprl) expect(recorded.has(versionKey(r.id, APRL_VERSION)), `${r.id} ${APRL_VERSION}`).toBe(true);
  });

  it('runs every shipped rule under either its shipped version or "before-versioning", never under nothing', () => {
    const catalogue = loadShippedCatalogue(REAL_DATA_DIR);
    const shipped = new Map(catalogue.rules.map(r => [r.id, r.version]));
    const running = new Map(rowsIfPresent(sqlite, 'rules').map(r => [String(r.id), r.version as string | null]));
    for (const [id, version] of shipped) {
      const actual = running.get(id);
      expect(actual, `${id} is stored with no version`).not.toBeNull();
      expect([version, 'before-versioning'], `${id} runs ${actual}`).toContain(actual);
    }
  });
});

describe('#163 · a fresh install', () => {
  it('runs every shipped rule at its shipped version, with nothing marked "before-versioning"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rb-fresh-'));
    const dataDir = join(dir, 'data');
    withRealPacks(dataDir);

    const db = openDatabase(join(dir, 'rulebeat.db'));
    try {
      runMigrations(db);
      runSeeds(db, dataDir);

      const catalogue = loadShippedCatalogue(REAL_DATA_DIR);
      const running = new Map(rowsIfPresent(db, 'rules').map(r => [String(r.id), r]));
      for (const shipped of catalogue.rules) {
        const row = running.get(shipped.id);
        expect(row, `${shipped.id} was not seeded`).toBeDefined();
        expect(row!.version, shipped.id).toBe(shipped.version);
        expect(row!.retired_at, shipped.id).toBeNull();
      }
      expect(running.get(catalogue.rules.find(r => r.pack === 'rulebeat-core')!.id)!.version).toBe('1.0.0');
      expect(running.get(catalogue.rules.find(r => r.pack === 'aprl-v2')!.id)!.version).toBe(APRL_VERSION);
      expect(rowsIfPresent(db, 'rule_versions').some(r => r.version === 'before-versioning')).toBe(false);
    } finally {
      db.close();
    }
  });
});
