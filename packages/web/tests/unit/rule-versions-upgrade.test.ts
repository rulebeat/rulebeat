/**
 * Tickets #163 and #246 · upgrading a real customer database.
 *
 * Every sample shape is put through the product's own migrations, then the seeder, with the real
 * shipped catalogue (Core plus the committed APRL pack). What an upgrade may never touch is compared
 * as content before and after: every rule's id, enabled state and tags, and the findings (with their
 * ages) and suppressions that hang off it. What it may change is the definition of a built-in that
 * has no version or sits on the removed "Before versioning" pseudo-version: it takes its pack's
 * shipped definition and version (ADR 0009), enabled or not, and nothing records "Before versioning".
 *
 * The "before" snapshot is taken after `runMigrations()` and before `runSeeds()`, because the older
 * migrations legitimately rename rule ids and tables; what these tickets change is the seeder.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase, runMigrations, runSeeds } from '@/lib/db/migrate';
import { definitionOfRow, sameDefinition, versionKey, type StoredRuleRow } from '@/lib/rule-versions';
import { loadShippedCatalogue } from '@/lib/shipped-catalogue';
import { SHAPES } from '../fixtures/db-shapes';
import { makeSample, open } from '../fixtures/upgrade';
import { rowsIfPresent } from '../fixtures/inspect';
import { LEGACY_PSEUDO_VERSION } from '../helpers/catalogue';

const REAL_DATA_DIR = join(resolve(__dirname, '..', '..'), 'data');
const APRL_VERSION = '2026-06-08T13:06:47Z';

/** What an upgrade may never change for a rule that already exists. */
const UNTOUCHED_COLUMNS = ['enabled', 'tags'] as const;

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

/** A `rules` row read the way the seeders read it, so its definition can be compared to a shipped one. */
function asStored(r: Row): StoredRuleRow {
  const text = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    id: String(r.id), name: String(r.name), description: String(r.description ?? ''), category: String(r.category),
    severity: String(r.severity), enabled: r.enabled === 1, scope: String(r.scope), resourceTypes: String(r.resource_types),
    conditions: String(r.conditions), conditionGroups: text(r.condition_groups), visualQuery: text(r.visual_query),
    projectColumns: text(r.project_columns), rawKql: text(r.raw_kql), queryBackend: String(r.query_backend ?? 'resource-graph'),
    kind: String(r.kind ?? 'state'), graphQuery: text(r.graph_query), logsQuery: text(r.logs_query), type: String(r.type),
    pack: text(r.pack), version: text(r.version), retiredAt: text(r.retired_at), originRuleId: text(r.origin_rule_id),
    originVersion: text(r.origin_version),
  };
}

/** Every table that holds rules or their versions, in a form that compares byte for byte. */
function dump(sqlite: Database): string {
  return JSON.stringify([
    sqlite.prepare(`SELECT * FROM rules ORDER BY id`).all(),
    sqlite.prepare(`SELECT * FROM rule_versions ORDER BY rule_id, version`).all(),
  ]);
}

describe.each(SHAPES)('#246 · %s · an upgrade moves built-ins to what ships and keeps everything else', shape => {
  let sqlite: Database;
  let before: { rules: Map<string, Row>; findings: Row[]; suppressions: Row[] };
  let after: { rules: Map<string, Row>; findings: Row[]; suppressions: Row[] };
  let dataDir: string;
  let file: string;
  /** Rules stored before the seeder ran whose definition differs from what ships. */
  let drifted = 0;

  beforeAll(() => {
    const sample = makeSample(shape);
    withRealPacks(sample.dataDir);
    dataDir = sample.dataDir;
    file = sample.file;

    const db = openDatabase(sample.file);
    try {
      runMigrations(db);
      before = {
        rules: ruleSnapshot(db),
        findings: rowsIfPresent(db, 'findings'),
        suppressions: rowsIfPresent(db, 'suppressions'),
      };
      const shippedById = new Map(loadShippedCatalogue(REAL_DATA_DIR).rules.map(r => [r.id, r]));
      drifted = rowsIfPresent(db, 'rules').filter(r => {
        const rule = shippedById.get(String(r.id));
        return rule !== undefined && r.query_backend !== undefined && !sameDefinition(definitionOfRow(asStored(r)), rule.definition);
      }).length;
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

  it('keeps every rule id, enabled state and tags', () => {
    for (const [id, was] of before.rules) {
      const now = after.rules.get(id);
      expect(now, `rule ${id} vanished`).toBeDefined();
      expect(now, `rule ${id} enabled state or tags`).toEqual(was);
    }
  });

  it('now runs the shipped definition and version for every built-in a pack ships, enabled or not', () => {
    const shipped = new Map(loadShippedCatalogue(REAL_DATA_DIR).rules.map(r => [r.id, r]));
    const rows = new Map(rowsIfPresent(sqlite, 'rules').map(r => [String(r.id), r]));
    for (const [id, rule] of shipped) {
      const row = rows.get(id);
      expect(row, `rule ${id} is missing`).toBeDefined();
      // An Identity built-in with a tuned query is converted to a custom rule instead.
      if (row!.type !== 'builtin') continue;
      expect(row!.version, `rule ${id} runs ${row!.version}`).toBe(rule.version);
      expect(sameDefinition(definitionOfRow(asStored(row!)), rule.definition), `rule ${id} runs a different definition`).toBe(true);
    }
    // The legacy-rules shape stores built-ins whose definitions differ from what ships, enabled and
    // disabled, so the loop above has changed rules to check.
    if (shape === 'legacy-rules') expect(drifted, 'no stored rule differed from what ships').toBeGreaterThan(0);
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
    expect(aprl).toHaveLength(141);
    for (const r of core) expect(recorded.has(versionKey(r.id, '1.0.0')), `${r.id} 1.0.0`).toBe(true);
    for (const r of aprl) expect(recorded.has(versionKey(r.id, APRL_VERSION)), `${r.id} ${APRL_VERSION}`).toBe(true);
  });

  it('leaves no rule or record on "Before versioning", and no built-in with no version unless it is retired', () => {
    expect(rowsIfPresent(sqlite, 'rules').filter(r => r.version === LEGACY_PSEUDO_VERSION || r.origin_version === LEGACY_PSEUDO_VERSION)).toEqual([]);
    expect(rowsIfPresent(sqlite, 'rule_versions').filter(r => r.version === LEGACY_PSEUDO_VERSION)).toEqual([]);
    const shipped = new Set(loadShippedCatalogue(REAL_DATA_DIR).rules.map(r => r.id));
    for (const r of rowsIfPresent(sqlite, 'rules')) {
      if (r.type !== 'builtin') continue;
      if (shipped.has(String(r.id))) expect(r.version, `${r.id} has no version`).not.toBeNull();
      else expect(r.version, `${r.id} is retired and has no version`).toBeNull();
    }
  });

  it('changes nothing on a second start', () => {
    const first = dump(sqlite);
    const db = openDatabase(file);
    try {
      runMigrations(db);
      runSeeds(db, dataDir);
    } finally {
      db.close();
    }
    const again = open(file);
    try {
      expect(dump(again)).toBe(first);
    } finally {
      again.close();
    }
  });
});

describe('#246 · a database an earlier release left on "Before versioning"', () => {
  let dir: string;
  let dataDir: string;
  let file: string;
  let coreId: string;
  let disabledId: string;
  let coreRow: Row;

  function insertRule(sqlite: Database, id: string, over: Record<string, unknown>): void {
    const row = { name: id, description: 'd', category: 'security', severity: 'low', enabled: 1, scope: '{"level":"resource"}', resource_types: '[]', conditions: '[]', raw_kql: 'Resources | project id', type: 'custom', ...over };
    const keys = Object.keys(row);
    sqlite.prepare(`INSERT INTO rules (id, ${keys.join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})`).run(id, ...Object.values(row));
  }
  function recordLegacy(sqlite: Database, ruleId: string): void {
    sqlite.prepare(`INSERT INTO rule_versions (rule_id, version, sort_key, release_note, definition, upstream_ref, first_seen_at) VALUES (?, ?, '', 'The definition this rule had before versions were recorded.', '{}', NULL, '2026-01-01T00:00:00.000Z')`).run(ruleId, LEGACY_PSEUDO_VERSION);
  }

  let findings: Row[];
  let suppressions: Row[];
  let ruleState: Map<string, Row>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'rb-legacy-version-'));
    dataDir = join(dir, 'data');
    withRealPacks(dataDir);
    file = join(dir, 'rulebeat.db');

    const db = openDatabase(file);
    try {
      runMigrations(db);
      runSeeds(db, dataDir, { skipOwnerBootstrap: true });

      // The state the earlier release wrote: an enabled Core rule tuned by hand and kept running under
      // the pseudo-version, a disabled one the same, a retired rule, and a copy made from one of them.
      const core = loadShippedCatalogue(REAL_DATA_DIR).rules.filter(r => r.pack === 'rulebeat-core' && r.definition.queryBackend === 'resource-graph');
      coreId = core[0]!.id;
      disabledId = core[1]!.id;
      db.prepare(`UPDATE rules SET severity = 'critical', description = 'tuned by an admin', tags = '["mine"]', version = ? WHERE id = ?`).run(LEGACY_PSEUDO_VERSION, coreId);
      db.prepare(`UPDATE rules SET severity = 'critical', enabled = 0, version = ? WHERE id = ?`).run(LEGACY_PSEUDO_VERSION, disabledId);
      recordLegacy(db, coreId);
      recordLegacy(db, disabledId);
      insertRule(db, 'retired-rule', { name: 'No longer shipped', type: 'builtin', pack: 'rulebeat-core', version: LEGACY_PSEUDO_VERSION, retired_at: '2026-02-02T00:00:00.000Z', severity: 'high' });
      recordLegacy(db, 'retired-rule');
      insertRule(db, 'copy', { name: 'Copy of a rule', origin_rule_id: coreId, origin_version: LEGACY_PSEUDO_VERSION });

      db.prepare(`INSERT INTO findings (fingerprint, rule_id, category, severity, subscription_id, title, first_seen_at, last_seen_at, times_seen) VALUES ('fp-1', ?, 'security', 'critical', 'sub', 't', '2026-03-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z', 4)`).run(coreId);
      db.prepare(`INSERT INTO suppressions (id, fingerprint, reason, suppressed_at) VALUES ('s-1', 'fp-1', 'accepted', '2026-03-02T00:00:00.000Z')`).run();
      coreRow = db.prepare(`SELECT * FROM rules WHERE id = ?`).get(coreId) as Row;
      findings = rowsIfPresent(db, 'findings');
      suppressions = rowsIfPresent(db, 'suppressions');
      ruleState = new Map(rowsIfPresent(db, 'rules').map(r => [String(r.id), { enabled: r.enabled, tags: r.tags }]));

      runSeeds(db, dataDir, { skipOwnerBootstrap: true });
    } finally {
      db.close();
    }
  });

  const read = <T>(fn: (db: Database) => T): T => {
    const db = open(file);
    try { return fn(db); } finally { db.close(); }
  };
  const rule = (id: string) => read(db => db.prepare(`SELECT * FROM rules WHERE id = ?`).get(id) as Row);

  it('moves an enabled shipped rule to the shipped definition and version', () => {
    const shipped = loadShippedCatalogue(REAL_DATA_DIR).rules.find(r => r.id === coreId)!;
    const row = rule(coreId);
    expect(row.version).toBe(shipped.version);
    expect(row.severity).toBe(shipped.definition.severity);
    expect(row.severity).not.toBe(coreRow.severity);
    expect(sameDefinition(definitionOfRow(asStored(row)), shipped.definition)).toBe(true);
    expect(row.enabled).toBe(1);
  });

  it('moves a disabled shipped rule the same way, and keeps it disabled', () => {
    const shipped = loadShippedCatalogue(REAL_DATA_DIR).rules.find(r => r.id === disabledId)!;
    const row = rule(disabledId);
    expect([row.version, row.enabled]).toEqual([shipped.version, 0]);
    expect(sameDefinition(definitionOfRow(asStored(row)), shipped.definition)).toBe(true);
  });

  it('keeps a retired rule\'s stored definition, leaves it retired and gives it no version', () => {
    const row = rule('retired-rule');
    expect([row.version, row.severity, row.retired_at, row.name]).toEqual([null, 'high', '2026-02-02T00:00:00.000Z', 'No longer shipped']);
  });

  it('clears the origin version of a custom copy, so its note reads "Duplicated from" with no newer-version sentence', () => {
    const row = rule('copy');
    expect([row.origin_rule_id, row.origin_version, row.type]).toEqual([coreId, null, 'custom']);
  });

  it('leaves no rule or record on "Before versioning"', () => {
    read(db => {
      expect(rowsIfPresent(db, 'rules').filter(r => r.version === LEGACY_PSEUDO_VERSION || r.origin_version === LEGACY_PSEUDO_VERSION)).toEqual([]);
      expect(rowsIfPresent(db, 'rule_versions').filter(r => r.version === LEGACY_PSEUDO_VERSION)).toEqual([]);
    });
  });

  it('keeps every rule id, enabled state and tag, every finding with its first-seen date, and every suppression', () => {
    read(db => {
      expect(rowsIfPresent(db, 'findings')).toEqual(findings);
      expect(rowsIfPresent(db, 'suppressions')).toEqual(suppressions);
      const now = new Map(rowsIfPresent(db, 'rules').map(r => [String(r.id), { enabled: r.enabled, tags: r.tags }]));
      expect(now).toEqual(ruleState);
    });
  });

  it('changes nothing on a second start', () => {
    const first = read(dump);
    const db = openDatabase(file);
    try { runSeeds(db, dataDir, { skipOwnerBootstrap: true }); } finally { db.close(); }
    expect(read(dump)).toBe(first);
  });
});

describe('#163 · a fresh install', () => {
  it('runs every shipped rule at its shipped version and records only shipped versions', () => {
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
      const shippedKeys = new Set(catalogue.rules.map(r => versionKey(r.id, r.version)));
      for (const r of rowsIfPresent(db, 'rule_versions')) expect(shippedKeys.has(versionKey(String(r.rule_id), String(r.version))), `${r.rule_id} ${r.version}`).toBe(true);
    } finally {
      db.close();
    }
  });
});
