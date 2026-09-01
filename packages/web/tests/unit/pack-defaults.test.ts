/**
 * B3 phase 1 · APRL ships disabled by default.
 *
 * All 143 APRL v2 reliability rules used to seed `enabled: true`, which made a first scan on a
 * fresh install a wall of noise with no fix attached to any of it (APRL carries descriptions and
 * docs links but no remediation; see docs/engineering/conventions/data.md). This suite pins
 * two separate guarantees:
 *
 *  - the committed pack JSON itself defaults every rule to disabled;
 *  - `seedPackRules()`'s re-seed UPDATE never touches `enabled` on a row that already exists, so an
 *    admin who turns a rule on keeps it on across every restart. The JSON assertion alone does not
 *    protect that — this second test is the one that actually gates it.
 *
 * Seeds against the real, committed `data/` directory (not a throwaway fixture dir) specifically so
 * this exercises the actual shipped `aprl-v2.json`, not a synthesised stand-in.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase, runMigrations, runSeeds } from '@/lib/db/migrate';

const WEB_ROOT = resolve(__dirname, '..', '..');
const REAL_DATA_DIR = join(WEB_ROOT, 'data');

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), 'rb-pack-defaults-'));
  return openDatabase(join(dir, 'rulebeat.db'));
}

function seed(sqlite: Database.Database): void {
  runMigrations(sqlite);
  // skipOwnerBootstrap: this suite only cares about the rules table, not user/password seeding.
  runSeeds(sqlite, REAL_DATA_DIR, { skipOwnerBootstrap: true });
}

describe('B3 · the committed pack JSON default', () => {
  it('every rule in data/packs/aprl-v2.json defaults to enabled: false', async () => {
    const packPath = join(REAL_DATA_DIR, 'packs', 'aprl-v2.json');
    const rules = JSON.parse(readFileSync(packPath, 'utf-8')) as Array<{ enabled: boolean }>;
    expect(rules.length).toBeGreaterThan(100);
    expect(rules.every(r => r.enabled === false)).toBe(true);
  });
});

describe('B3 · a fresh install starts quiet', () => {
  it('exactly 12 rules are enabled — the builtin core set plus the two identity checks, none of APRL', async () => {
    const sqlite = freshDb();
    try {
      seed(sqlite);
      const total = sqlite.prepare(`SELECT COUNT(*) AS n FROM rules`).get() as { n: number };
      const enabled = sqlite.prepare(`SELECT COUNT(*) AS n FROM rules WHERE enabled = 1`).get() as { n: number };
      expect(total.n).toBeGreaterThan(140);
      // 10 rulebeat-core resource-graph rules + 2 identity checks (spec 029 made the identity checks
      // real, disableable `rules` rows instead of an isSpecial category that always ran unconditionally
      // — seeded enabled:1 so the upgrade doesn't silently stop checking credentials that were always
      // being checked before).
      expect(enabled.n).toBe(12);
    } finally {
      sqlite.close();
    }
  });

  it('re-seeding never re-disables a rule an admin already turned on (the upgrade guarantee)', async () => {
    const sqlite = freshDb();
    try {
      seed(sqlite);
      const aprlRule = sqlite.prepare(`SELECT id FROM rules WHERE pack = 'aprl-v2' LIMIT 1`).get() as { id: string } | undefined;
      expect(aprlRule, 'expected at least one aprl-v2 rule to have been seeded').toBeDefined();

      sqlite.prepare(`UPDATE rules SET enabled = 1 WHERE id = ?`).run(aprlRule!.id);
      seed(sqlite); // re-seed, the way every restart does

      const row = sqlite.prepare(`SELECT enabled FROM rules WHERE id = ?`).get(aprlRule!.id) as { enabled: number };
      expect(row.enabled).toBe(1);
    } finally {
      sqlite.close();
    }
  });
});

describe('spec 031 · taxonomy defaults for real pack-seeded rules', () => {
  // seedPackRules()'s own INSERT (migrate.ts) never mentions shape/kind/applies_to at all — none of
  // aprl-v2.json's rule objects carry those fields, since the pack predates spec 031 by definition.
  // Safety here rests entirely on the `shape`/`kind` columns' own SQL-level
  // `NOT NULL DEFAULT ...` (migrate.ts's ALTER TABLE statements), not on any TypeScript code path —
  // deriveShape()/deriveKind() are never called by this raw-SQL seeding path the way ruleToRow() calls
  // them for a UI-authored save. A DEFAULT dropped from a future rewrite of that ALTER, or an INSERT
  // rewritten to list every column explicitly (which would then insert a literal NULL instead of
  // falling back), would slip past every other spec 031 test in this suite, since all of them save
  // rules through lib/rules.ts rather than through this seeding path. Run against the real, committed
  // aprl-v2.json (via the same seed() helper as the tests above), not a synthesised stand-in.
  it('every real aprl-v2 rule seeds with shape detect, kind state, and no applies_to', async () => {
    const sqlite = freshDb();
    try {
      seed(sqlite);
      const rows = sqlite.prepare(
        `SELECT id, shape, kind, applies_to, query_backend FROM rules WHERE pack = 'aprl-v2'`,
      ).all() as { id: string; shape: string | null; kind: string | null; applies_to: string | null; query_backend: string }[];

      expect(rows.length).toBeGreaterThan(100);
      for (const row of rows) {
        expect(row.query_backend, `"${row.id}" did not default to resource-graph`).toBe('resource-graph');
        expect(row.shape, `"${row.id}" did not default to detect`).toBe('detect');
        expect(row.kind, `"${row.id}" did not default to state`).toBe('state');
        expect(row.applies_to, `"${row.id}" unexpectedly has an applies_to`).toBeNull();
      }
    } finally {
      sqlite.close();
    }
  });
});
