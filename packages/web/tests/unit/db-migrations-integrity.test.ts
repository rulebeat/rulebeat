/**
 * TS-25 · the individual migration steps that can lose data quietly.
 *
 * Where `db-migrations.test.ts` asks "did a customer's content survive a whole upgrade", this one
 * pins the specific mechanics that make losing it possible — column-rename ordering, in-place
 * backfills, id rewrites that have to reach five tables, and what happens when an upgrade is
 * interrupted halfway.
 *
 * Each test builds the smallest database that can exhibit the behaviour, rather than reusing a whole
 * shape, so a failure names one migration rather than a lineage.
 */
import { describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { computeFingerprint, buildRuleQuery, type Rule } from '@rulebeat/core';
import { runMigrations, runSeeds } from '@/lib/db/migrate';
import { makeSample, open, upgradeInProcess, type Sample } from '../fixtures/upgrade';
import { columnsOf, dumpDb, rowsOf, tableExists, tableNames } from '../fixtures/dump';

/** An empty sample with whatever starting schema and rows the test needs. */
function sampleWith(ddl: string, seed?: (sqlite: Database) => void): Sample {
  const sample = makeSample('current');
  const sqlite = open(sample.file);
  try {
    sqlite.exec(ddl);
    seed?.(sqlite);
  } finally {
    sqlite.close();
  }
  return sample;
}

/** Runs only the migrations, leaving seeding out — keeps a focused test's assertions uncluttered. */
function migrateOnly(sample: Sample): Database {
  const sqlite = open(sample.file);
  runMigrations(sqlite);
  return sqlite;
}

const RULES_LEGACY = `
  CREATE TABLE rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    severity TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    scope TEXT NOT NULL,
    resource_types TEXT NOT NULL,
    filter TEXT,
    rules TEXT NOT NULL DEFAULT '[]',
    rule_groups TEXT,
    source TEXT,
    group_name TEXT
  );`;

function insertRule(sqlite: Database, over: Record<string, unknown>): void {
  const row: Record<string, unknown> = {
    id: 'r1', name: 'r1', description: '', category: 'cost', severity: 'low',
    enabled: 1, scope: '{}', resource_types: '[]', rules: '[]',
    rule_groups: null, source: null, group_name: null, ...over,
  };
  const keys = Object.keys(row);
  sqlite.prepare(`INSERT INTO rules (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map(k => row[k]));
}

// ── Column renames: order decides whether data survives ───────────────────────

describe('TS-25 · renaming a column must carry its data', () => {
  it('25-04 · source → type keeps each row\'s own provenance', () => {
    const sample = sampleWith(RULES_LEGACY, sqlite => {
      insertRule(sqlite, { id: 'a', name: 'a builtin', source: 'builtin' });
      insertRule(sqlite, { id: 'b', name: 'a community rule', source: 'community' });
      insertRule(sqlite, { id: 'c', name: 'a custom rule', source: 'custom' });
      insertRule(sqlite, { id: 'd', name: 'never classified', source: null });
    });

    const sqlite = migrateOnly(sample);
    try {
      const byId = Object.fromEntries(
        (sqlite.prepare(`SELECT id, type FROM rules`).all() as { id: string; type: string | null }[])
          .map(r => [r.id, r.type]),
      );
      // If ADD COLUMN ran before RENAME, every one of these would read 'custom' — the column would
      // exist, the upgrade would look successful, and every rule's provenance would be wrong.
      expect(byId).toEqual({ a: 'builtin', b: 'community', c: 'custom', d: null });
      expect(columnsOf(sqlite, 'rules')).not.toContain('source');
    } finally { sqlite.close(); }
  });

  // spec 031 changed what "carries its data" means for these two columns once a row has no raw_kql
  // of its own: the rename still has to succeed (that's still what RB-QA-010 was about — an ADD
  // COLUMN run before the RENAME swallows the failure and stands up an empty column, stranding the
  // old one), but the data no longer sits unchanged in the renamed column afterward. A second,
  // gated migration step (migrate.ts's legacyConditionRows block) compiles it into raw_kql through
  // buildRuleQuery() and clears the legacy column — see that block's own comment. Both tests below
  // compute the expected KQL by calling buildRuleQuery() with the same compileTarget shape that
  // block builds, rather than hand-typing a KQL string that would drift the moment the compiler's
  // output format changes — the same reasoning the fingerprint tests elsewhere in this suite use
  // computeFingerprint() itself instead of a hand-typed hash.
  //
  // Both fixtures use two conditions joined by 'or' (not one, and deliberately not 'and') so the
  // migration's own JSON.parse of the legacy column round-trips a real `join` field into
  // buildRuleQuery(), the same shape already proven to need the De Morgan flip in core's
  // de-morgan-join-flip.test.ts. That file proves buildRuleQuery() itself flips correctly; a
  // single-condition fixture here would never exercise that path at all, since there is no join to
  // flip — it would only prove the migration calls buildRuleQuery() with *something*, not that it
  // hands the compiler the row's real join structure instead of e.g. losing it during its own JSON
  // reshaping. 'or' is the deliberate choice, not 'and': buildConditionGroupExpr() falls back to
  // `cond.join ?? 'and'` for a condition with no join at all, so a fixture using 'and' cannot tell a
  // correctly-preserved join apart from one silently dropped to the default — confirmed by hand: a
  // kill-switch that stripped `join` from every parsed condition before compiling left an 'and'-based
  // version of these two tests fully green. 'or' has no such collision with the fallback.

  it('25-04 · rule_groups → condition_groups compiles into raw_kql and clears the legacy column', () => {
    const groups = [{
      id: 'g1',
      conditions: [
        { field: 'name', operator: 'equals', value: 'x' },
        { field: 'location', operator: 'equals', value: 'westeurope', join: 'or' },
      ],
    }];
    const sample = sampleWith(RULES_LEGACY, sqlite => {
      insertRule(sqlite, { id: 'a', name: 'has groups', rule_groups: JSON.stringify(groups) });
    });

    const sqlite = migrateOnly(sample);
    try {
      expect(columnsOf(sqlite, 'rules')).not.toContain('rule_groups');

      const row = sqlite.prepare(`SELECT raw_kql, conditions, condition_groups FROM rules WHERE id = 'a'`)
        .get() as { raw_kql: string | null; conditions: string; condition_groups: string | null };
      const expectedKql = buildRuleQuery({ scope: {}, resourceTypes: [], conditions: [], conditionGroups: groups } as unknown as Rule);

      expect(row.raw_kql, 'the nested condition logic was lost instead of being compiled').toBe(expectedKql);
      // Guards against a migration that silently drops the join (falls back to 'and', flips to 'or')
      // instead of preserving the row's real 'or' (which flips to 'and') — see the comment above.
      expect(row.raw_kql).toContain(' and ');
      expect(row.conditions).toBe('[]');
      expect(row.condition_groups, 'condition groups were stranded in the old column instead of being cleared once compiled').toBeNull();
    } finally { sqlite.close(); }
  });

  it('25-04 · rules → conditions compiles into raw_kql and clears the legacy column', () => {
    const conditions = [
      { field: 'location', operator: 'equals', value: 'westeurope' },
      { field: 'name', operator: 'equals', value: 'x', join: 'or' },
    ];
    const sample = sampleWith(RULES_LEGACY, sqlite => {
      insertRule(sqlite, { id: 'a', name: 'has conditions', rules: JSON.stringify(conditions) });
    });

    const sqlite = migrateOnly(sample);
    try {
      const row = sqlite.prepare(`SELECT raw_kql, conditions FROM rules WHERE id = 'a'`)
        .get() as { raw_kql: string | null; conditions: string };
      const expectedKql = buildRuleQuery({ scope: {}, resourceTypes: [], conditions, conditionGroups: undefined } as unknown as Rule);

      expect(row.raw_kql, 'the flat condition list was lost instead of being compiled').toBe(expectedKql);
      // Same join-flip guard as above — a flat rule.conditions list compiles through the identical
      // single-group-shorthand path in buildRuleQuery() (see that function's own comment), so it is
      // just as able to silently lose its join during the migration's JSON reshaping.
      expect(row.raw_kql).toContain(' and ');
      expect(row.conditions, 'legacy conditions were left in place instead of being cleared once compiled').toBe('[]');
    } finally { sqlite.close(); }
  });
});

// ── The group_name → tags backfill ────────────────────────────────────────────

describe('TS-25 · the group → tags backfill', () => {
  function tagsAfterMigrating(rows: Record<string, unknown>[]): Record<string, string | null> {
    const sample = sampleWith(RULES_LEGACY, sqlite => {
      for (const r of rows) insertRule(sqlite, r);
    });
    const sqlite = migrateOnly(sample);
    try {
      return Object.fromEntries(
        (sqlite.prepare(`SELECT id, tags FROM rules`).all() as { id: string; tags: string | null }[])
          .map(r => [r.id, r.tags]),
      );
    } finally { sqlite.close(); }
  }

  it('25-04 · a group becomes a one-element tag list', () => {
    expect(tagsAfterMigrating([{ id: 'a', group_name: 'Production' }]).a).toBe('["Production"]');
  });

  it('25-04 · a group containing a quote produces valid JSON', () => {
    const tags = tagsAfterMigrating([{ id: 'a', group_name: 'Prod "A"' }]).a;
    expect(() => JSON.parse(tags!)).not.toThrow();
    expect(JSON.parse(tags!)).toEqual(['Prod "A"']);
  });

  it('25-04 · tags a user already set are left alone', () => {
    // The guard that protects this is the WHERE clause. Without it an upgrade would silently discard
    // whatever tagging a user had done since.
    const sample = sampleWith(RULES_LEGACY, sqlite => insertRule(sqlite, { id: 'a', group_name: 'Ignored' }));
    const first = open(sample.file);
    first.exec(`ALTER TABLE rules ADD COLUMN tags TEXT`);
    first.prepare(`UPDATE rules SET tags = ? WHERE id = 'a'`).run('["Kept","Also kept"]');
    first.close();

    const sqlite = migrateOnly(sample);
    try {
      const row = sqlite.prepare(`SELECT tags FROM rules WHERE id = 'a'`).get() as { tags: string };
      expect(row.tags).toBe('["Kept","Also kept"]');
    } finally { sqlite.close(); }
  });

  it('25-04 · a blank group does not become a tag', () => {
    expect(tagsAfterMigrating([{ id: 'a', group_name: '   ' }]).a).toBeNull();
  });

  it('25-11 · upgrading twice does not nest the tag list inside itself', () => {
    const sample = sampleWith(RULES_LEGACY, sqlite => insertRule(sqlite, { id: 'a', group_name: 'Production' }));
    for (let i = 0; i < 3; i++) {
      const sqlite = open(sample.file);
      runMigrations(sqlite);
      sqlite.close();
    }
    const sqlite = open(sample.file);
    try {
      const row = sqlite.prepare(`SELECT tags FROM rules WHERE id = 'a'`).get() as { tags: string };
      expect(row.tags, 'the backfill re-wrapped its own output').toBe('["Production"]');
    } finally { sqlite.close(); }
  });
});

// ── The two identity checks seed exactly once, taxonomy intact (spec 029) ────

describe('TS-25 · the identity rules seed exactly once (spec 029)', () => {
  it('25-14 · upgrading three times leaves exactly one row per identity check, taxonomy unchanged', () => {
    const sample = makeSample('pre-rbac');
    for (let i = 0; i < 3; i++) upgradeInProcess(sample);

    const sqlite = open(sample.file);
    try {
      for (const id of ['cred:app-secret-expiring', 'cred:app-cert-expiring']) {
        const rows = sqlite.prepare(`SELECT query_backend, shape, kind FROM rules WHERE id = ?`).all(id) as
          { query_backend: string; shape: string; kind: string }[];
        expect(rows.length, `"${id}" was duplicated by repeated upgrades`).toBe(1);
        expect(rows[0]!.query_backend).toBe('microsoft-graph');
        expect(rows[0]!.shape).toBe('detect');
        expect(rows[0]!.kind).toBe('state');
      }
    } finally { sqlite.close(); }
  });
});

// ── Rewriting rule ids has to reach everything that references them ───────────

describe('TS-25 · rewriting a rule id', () => {
  const OLD_ID = 'builtin::tag-environment';
  const NEW_ID = 'db175338-5c33-484a-bcf5-24f20e3bc60c';

  it('25-03 · a user\'s edited rule wins over a stand-in already sitting at the new id', () => {
    // This is the corrupted shape a previously-interrupted upgrade leaves behind: the rename did not
    // finish, seeding then re-created the built-in under its new id, and now both exist. The row
    // carrying the user's changes is the one that must survive.
    const sample = sampleWith(RULES_LEGACY, sqlite => {
      insertRule(sqlite, { id: OLD_ID, name: 'Tag: environment', enabled: 0, group_name: 'Mine' });
      insertRule(sqlite, { id: NEW_ID, name: 'Tag: environment', enabled: 1 });
    });

    const sqlite = migrateOnly(sample);
    try {
      const rows = sqlite.prepare(`SELECT id, enabled, group_name FROM rules`).all() as
        { id: string; enabled: number; group_name: string | null }[];
      expect(rows.length, 'the collision left two rows behind').toBe(1);
      expect(rows[0]!.id).toBe(NEW_ID);
      expect(rows[0]!.enabled, 'the user\'s disabled state was overwritten by the stand-in').toBe(0);
      expect(rows[0]!.group_name).toBe('Mine');
    } finally { sqlite.close(); }
  });

  it('25-03 · one failing rename does not abandon the rest', () => {
    // Each pair is renamed in its own try/catch precisely so a single bad one cannot abort the loop
    // and leave every later rule to be re-seeded as a duplicate. Nothing proved that until now.
    const sample = sampleWith(RULES_LEGACY, sqlite => {
      insertRule(sqlite, { id: 'builtin::orphan-unattached-disk', name: 'first' });
      insertRule(sqlite, { id: OLD_ID, name: 'last' });
    });

    const sqlite = migrateOnly(sample);
    try {
      const ids = (sqlite.prepare(`SELECT id FROM rules`).all() as { id: string }[]).map(r => r.id);
      expect(ids, 'a later rename was skipped').toContain(NEW_ID);
      expect(ids.every(id => !id.startsWith('builtin::'))).toBe(true);
    } finally { sqlite.close(); }
  });
});

describe('TS-25 · a renamed rule keeps its findings addressable', () => {
  /**
   * The contract: a finding's stored fingerprint must equal what the product would compute for it
   * today. Fingerprints are `sha256(ruleId::resourceId)` and are recomputed from scratch on every
   * scan (`lib/scan-runner.ts`), while the id-rewriting migration deliberately leaves the stored
   * fingerprint alone — its comment calls it "an opaque hash, never recomputed here".
   *
   * Both halves are individually reasonable and together they break: after a rule's id changes, the
   * next scan derives a different fingerprint for the same violation on the same resource. The old
   * finding is never matched again, so its age and history are stranded; the violation is reported
   * as brand new; and every suppression, which keys on the fingerprint, silently stops suppressing.
   *
   * Fixed by `remapFingerprints` (RB-QA-013), which moves findings, events and suppressions onto the
   * fingerprint the new id produces — matching each row exactly rather than inferring, so nothing
   * whose fingerprint was not derived from the old id is touched.
   */
  it('25-05 · every finding\'s fingerprint still matches its rule', () => {
    const sample = makeSample('legacy-rules');
    upgradeInProcess(sample);
    const sqlite = open(sample.file);
    try {
      const findings = rowsOf(sqlite, 'findings');
      expect(findings.length, 'nothing to check').toBeGreaterThan(0);
      for (const f of findings) {
        expect(
          computeFingerprint(String(f.rule_id), String(f.resource_id)),
          `finding on ${String(f.resource_name)} can no longer be recognised by a scan`,
        ).toBe(String(f.fingerprint));
      }
    } finally { sqlite.close(); }
  });

  it('25-09 · a suppression still silences the same violation after its rule is renamed', () => {
    // The user-visible half of the same fix. A suppression stores only a fingerprint and a resource
    // id, so if the fingerprint is not carried across the rename, an accepted risk quietly starts
    // alerting again on the next scan — with nothing anywhere to say why.
    const sample = makeSample('legacy-rules');
    upgradeInProcess(sample);
    const sqlite = open(sample.file);
    try {
      const suppression = rowsOf(sqlite, 'suppressions')[0]!;
      const finding = rowsOf(sqlite, 'findings')
        .find(f => f.resource_id === suppression.resource_id);
      expect(finding, 'the suppressed finding is missing').toBeDefined();

      // What the next scan will compute for that violation, from the rule's *current* id.
      const whatTheNextScanWillCompute = computeFingerprint(
        String(finding!.rule_id), String(suppression.resource_id),
      );
      expect(
        String(suppression.fingerprint),
        'the suppression would no longer match the finding it was created for',
      ).toBe(whatTheNextScanWillCompute);
    } finally { sqlite.close(); }
  });

  it('25-05 · a lineage whose rule ids never change keeps its findings addressable', () => {
    // The same assertion where no rename happens, proving the failure above is caused by the rename
    // and not by the fixtures or the fingerprint formula.
    const sample = makeSample('pre-rbac');
    upgradeInProcess(sample);
    const sqlite = open(sample.file);
    try {
      const findings = rowsOf(sqlite, 'findings');
      expect(findings.length).toBeGreaterThan(0);
      for (const f of findings) {
        expect(computeFingerprint(String(f.rule_id), String(f.resource_id))).toBe(String(f.fingerprint));
      }
    } finally { sqlite.close(); }
  });
});

describe('TS-25 · no legacy identifier survives anywhere', () => {
  const LEGACY_PATTERNS = [/builtin::/, /orphan::/, /standards::/, /"ruleId":"tag-required-/];

  /** Every text value in the database, so nothing is checked by enumeration alone. */
  function everyTextValue(sqlite: Database): { table: string; column: string; value: string }[] {
    const found: { table: string; column: string; value: string }[] = [];
    for (const table of tableNames(sqlite)) {
      for (const row of rowsOf(sqlite, table)) {
        for (const [column, value] of Object.entries(row)) {
          if (typeof value === 'string') found.push({ table, column, value });
        }
      }
    }
    return found;
  }

  for (const shape of ['policies-era', 'legacy-rules'] as const) {
    it(`25-05 · ${shape} leaves no old-scheme rule id behind`, () => {
      const sample = makeSample(shape);
      upgradeInProcess(sample);
      const sqlite = open(sample.file);
      try {
        const offenders = everyTextValue(sqlite)
          .filter(v => LEGACY_PATTERNS.some(p => p.test(v.value)))
          .map(v => `${v.table}.${v.column}: ${v.value.slice(0, 80)}`);
        // A stale id in a JSON blob is not cosmetic: findings and dashboard widgets keyed on it stop
        // resolving to a rule, so drill-through and the top-rules widgets quietly go blank.
        expect([...new Set(offenders)], 'these still carry a pre-UUID rule id').toEqual([]);
      } finally { sqlite.close(); }
    });
  }
});

// ── An upgrade interrupted partway through ────────────────────────────────────

describe('TS-25 · an interrupted upgrade recovers on the next start', () => {
  const OLD_SNAPSHOTS = `
    CREATE TABLE compliance_snapshots (
      category TEXT NOT NULL,
      date TEXT NOT NULL,
      compliance_pct INTEGER,
      passing_rules INTEGER NOT NULL DEFAULT 0,
      total_rules INTEGER NOT NULL DEFAULT 0,
      active_findings INTEGER NOT NULL DEFAULT 0,
      severity_counts TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (category, date)
    );`;

  const NEW_SNAPSHOTS = `
    CREATE TABLE compliance_snapshots_new (
      category TEXT NOT NULL,
      subscription_id TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL,
      compliance_pct INTEGER,
      passing_rules INTEGER NOT NULL DEFAULT 0,
      total_rules INTEGER NOT NULL DEFAULT 0,
      active_findings INTEGER NOT NULL DEFAULT 0,
      severity_counts TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (category, subscription_id, date)
    );`;

  const addOldRow = (sqlite: Database) => sqlite.prepare(
    `INSERT INTO compliance_snapshots (category, date, compliance_pct, updated_at) VALUES ('cost','2026-07-19',80,'t')`,
  ).run();

  const addNewRow = (sqlite: Database) => sqlite.prepare(
    `INSERT INTO compliance_snapshots_new (category, subscription_id, date, compliance_pct, updated_at) VALUES ('cost','','2026-07-19',80,'t')`,
  ).run();

  /**
   * The rebuild is CREATE → INSERT → DROP → RENAME, run without a transaction. Interrupting it
   * leaves one of these three states on disk. All three must come out the same way: history intact,
   * new key in place, nothing half-built left behind.
   */
  const CASES = [
    { name: 'stopped after creating the new table', ddl: `${OLD_SNAPSHOTS}${NEW_SNAPSHOTS}`, seed: addOldRow },
    { name: 'stopped after copying the rows across', ddl: `${OLD_SNAPSHOTS}${NEW_SNAPSHOTS}`, seed: (s: Database) => { addOldRow(s); addNewRow(s); } },
    { name: 'stopped after dropping the old table', ddl: NEW_SNAPSHOTS, seed: addNewRow },
  ];

  for (const c of CASES) {
    it(`25-13 · ${c.name}`, () => {
      const sample = sampleWith(c.ddl, c.seed);
      const sqlite = migrateOnly(sample);
      try {
        expect(tableExists(sqlite, 'posture_snapshots')).toBe(true);
        expect(columnsOf(sqlite, 'posture_snapshots')).toContain('subscription_id');
        expect(tableExists(sqlite, 'compliance_snapshots_new'), 'scaffolding left behind').toBe(false);

        const rows = sqlite.prepare(`SELECT * FROM posture_snapshots`).all() as Record<string, unknown>[];
        expect(rows.length, 'trend history was lost').toBe(1);
        expect(rows[0]!.posture_pct).toBe(80);
      } finally { sqlite.close(); }
    });
  }
});

// ── Running it twice ─────────────────────────────────────────────────────────

describe('TS-25 · upgrading is repeatable', () => {
  for (const shape of ['policies-era', 'legacy-rules', 'cron-schedules', 'pre-rbac', 'current'] as const) {
    it(`25-11 · ${shape} · a second and third start change nothing`, () => {
      const sample = makeSample(shape);
      upgradeInProcess(sample);

      const dumpAfter = () => {
        const sqlite = open(sample.file);
        const d = dumpDb(sqlite);
        sqlite.close();
        return d;
      };

      const first = dumpAfter();
      upgradeInProcess(sample);
      const second = dumpAfter();
      upgradeInProcess(sample);
      const third = dumpAfter();

      // Whole-database equality, not a set of counts: a duplicate row, a re-seeded default, a
      // backfill applied twice or a marker that failed to stick all show up here and nowhere else.
      expect(second, 'the second start changed the database').toBe(first);
      expect(third, 'the third start changed the database').toBe(second);
    });
  }
});

// ── Seeding must never precede the schema it writes into ─────────────────────

describe('TS-25 · seeding runs against an already-migrated schema', () => {
  it('25-02 · seeding a legacy-shaped database writes built-ins with their modern columns', () => {
    // `runSeeds` inserts into columns (type, pack, raw_kql) that only exist because `runMigrations`
    // added them. Calling them out of order fails loudly here rather than on a customer's machine.
    const sample = sampleWith(RULES_LEGACY, sqlite => insertRule(sqlite, { id: 'a', name: 'mine' }));
    const sqlite = open(sample.file);
    try {
      runMigrations(sqlite);
      runSeeds(sqlite, sample.dataDir);
      const builtins = sqlite.prepare(`SELECT COUNT(*) AS n FROM rules WHERE type = 'builtin'`).get() as { n: number };
      expect(builtins.n).toBeGreaterThan(0);
      expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM rules WHERE name = 'mine'`).get()).toEqual({ n: 1 });
    } finally { sqlite.close(); }
  });
});

// ── A rule survives the last-run-status column addition (spec 030) ──────────

/** The rules table one migration before spec 030 added last_run_status/last_run_at — every other
 *  column already at its modern name. Scoped to exactly this step rather than reusing RULES_LEGACY,
 *  since that shape predates raw_kql and can't carry the "KQL untouched" assertion below. Each
 *  column addition in migrate.ts is its own independent, idempotent ALTER TABLE, so a DDL missing
 *  only the two newest columns is a faithful "one migration behind" fixture. */
const RULES_PRE_LAST_RUN_STATUS = `
  CREATE TABLE rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    severity TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    scope TEXT NOT NULL,
    resource_types TEXT NOT NULL,
    filter TEXT,
    conditions TEXT NOT NULL,
    project_columns TEXT,
    raw_kql TEXT,
    condition_groups TEXT,
    type TEXT NOT NULL DEFAULT 'custom',
    pack TEXT,
    query_backend TEXT NOT NULL DEFAULT 'resource-graph',
    shape TEXT NOT NULL DEFAULT 'detect',
    kind TEXT NOT NULL DEFAULT 'state',
    group_name TEXT,
    tags TEXT,
    visual_query TEXT
  );`;

function insertModernRule(sqlite: Database, over: Record<string, unknown>): void {
  const row: Record<string, unknown> = {
    id: 'r1', name: 'r1', description: '', category: 'cost', severity: 'low',
    enabled: 1, scope: '{}', resource_types: '[]', conditions: '[]', raw_kql: null,
    type: 'custom', query_backend: 'resource-graph', shape: 'detect', kind: 'state',
    ...over,
  };
  const keys = Object.keys(row);
  sqlite.prepare(`INSERT INTO rules (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map(k => row[k]));
}

describe('TS-25 · a rule survives the last-run-status column addition (spec 030)', () => {
  it('spec 030 · name, raw KQL and enabled state are untouched; the new columns land present and NULL', () => {
    const sample = sampleWith(RULES_PRE_LAST_RUN_STATUS, sqlite => insertModernRule(sqlite, {
      id: 'r1',
      name: 'My VM rule',
      enabled: 0,
      raw_kql: 'resources | where type == "microsoft.compute/virtualmachines"',
    }));

    const sqlite = migrateOnly(sample);
    try {
      expect(columnsOf(sqlite, 'rules')).toEqual(expect.arrayContaining(['last_run_status', 'last_run_at']));

      const row = sqlite.prepare(
        `SELECT name, raw_kql, enabled, last_run_status, last_run_at FROM rules WHERE id = 'r1'`,
      ).get() as { name: string; raw_kql: string; enabled: number; last_run_status: string | null; last_run_at: string | null };

      expect(row.name).toBe('My VM rule');
      expect(row.raw_kql).toBe('resources | where type == "microsoft.compute/virtualmachines"');
      expect(row.enabled, 'a disabled rule must not come back enabled').toBe(0);
      expect(row.last_run_status).toBeNull();
      expect(row.last_run_at).toBeNull();
    } finally { sqlite.close(); }
  });
});
