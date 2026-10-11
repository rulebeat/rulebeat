/**
 * Shared by the SQLite and Postgres tests of the APRL query correction (#221): what a database held
 * before the fix, built from a saved copy of the pack as it used to ship, and what it holds after.
 *
 * `tests/fixtures/aprl-v2-before-221.json` is eight entries of the old `aprl-v2.json`, saved before
 * the pack was regenerated. Five of them carried another recommendation's query (CHANGED); three
 * carried their own (UNCHANGED). The expected queries are read from the committed pack, so a
 * regeneration that paired a rule wrongly again fails the test rather than moving it.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadShippedCatalogue, type ShippedCatalogue } from '@/lib/shipped-catalogue';

export const REAL_DATA_DIR = join(resolve(__dirname, '..', '..'), 'data');

export const CHANGED = [
  'bb6deb9d-24fa-4ee8-bc23-ac3ebc7fdf8e', // "Use at least the Enterprise SKU", ran the replica-set query
  'a3058909-fcf8-4450-88b5-499f57449178', // "Use replica sets ...", ran the SKU query
  '9ec5b4c8-3dd8-473a-86ee-3273290331b9',
  '4232eb32-3241-4049-9e14-9b8005817b56',
  '4ee5d535-c47b-470a-9557-4a3dd297d62f',
] as const;
export const UNCHANGED = [
  'f4201965-a88d-449d-b3b4-021394719eb2',
  '5a44bd30-ae6a-4b81-9b68-dc3a8ffca4d8',
  '3263a64a-c256-de48-9818-afd3cbc55c2a',
] as const;

type PackEntry = { id: string; rawKql: string; version?: string; releaseNote?: string };

const readPack = (file: string) => JSON.parse(readFileSync(file, 'utf-8')) as PackEntry[];
export const oldPackEntries = () => readPack(join(__dirname, '..', 'fixtures', 'aprl-v2-before-221.json'));
export const committedPackEntries = () => readPack(join(REAL_DATA_DIR, 'packs', 'aprl-v2.json'));

/** What this build shipped before the fix: Core plus the fixture's eight APRL rules. */
export function oldCatalogue(): ShippedCatalogue {
  const dir = mkdtempSync(join(tmpdir(), 'rb-aprl-old-'));
  mkdirSync(join(dir, 'packs'));
  cpSync(join(REAL_DATA_DIR, 'packs', 'pack-manifest.json'), join(dir, 'packs', 'pack-manifest.json'));
  writeFileSync(join(dir, 'packs', 'aprl-v2.json'), JSON.stringify(oldPackEntries()));
  return loadShippedCatalogue(dir);
}

/** What this build ships: Core plus the committed APRL pack. */
export const committedCatalogue = () => loadShippedCatalogue(REAL_DATA_DIR);

/** The Core rule whose findings must come through untouched. */
export function coreRuleId(catalogue: ShippedCatalogue): string {
  return catalogue.rules.find(r => r.pack === 'rulebeat-core')!.id;
}

/** Findings of one rule in every table a rule's findings live in. Plain SQL both backends accept. */
function findingSql(ruleId: string, label: string, status: 'active' | 'fixed'): string[] {
  const fp = `fp-${label}`;
  return [
    `INSERT INTO findings (fingerprint, rule_id, category, severity, subscription_id, title, status, first_seen_at, last_seen_at, resolved_at, times_seen)
     VALUES ('${fp}', '${ruleId}', 'reliability', 'high', 'sub-1', 'A finding', '${status}', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', ${status === 'fixed' ? `'2026-02-01T00:00:00.000Z'` : 'NULL'}, 9)`,
    `INSERT INTO finding_rows (fingerprint, position, data) VALUES ('${fp}', 0, '{"param1":"${label}"}')`,
    `INSERT INTO finding_events (id, fingerprint, rule_id, category, scan_id, type, occurred_at)
     VALUES ('ev-${label}', '${fp}', '${ruleId}', 'reliability', 'scan-1', 'created', '2026-01-01T00:00:00.000Z')`,
  ];
}

/**
 * Open and fixed findings, a column catalogue, a suppression and a scan record for the rules the
 * correction touches, and findings for rules it must not touch (an unchanged APRL rule and a Core
 * rule). Also a posture snapshot.
 */
export function populationSql(core: string): string[] {
  const [a, b, c] = CHANGED;
  return [
    ...findingSql(a, 'a-open', 'active'),
    ...findingSql(a, 'a-fixed', 'fixed'),
    ...findingSql(b, 'b-fixed', 'fixed'),
    ...findingSql(c, 'c-open', 'active'),
    ...findingSql(UNCHANGED[0], 'u-open', 'active'),
    ...findingSql(core, 'core-open', 'active'),
    `INSERT INTO column_catalogue (rule_id, path) VALUES ('${a}', 'param1'), ('${b}', 'param1'), ('${UNCHANGED[0]}', 'param1'), ('${core}', 'param1')`,
    `INSERT INTO suppressions (id, fingerprint, resource_id, reason, suppressed_at)
     VALUES ('sup-a', 'fp-a-open', 'res-a', 'Accepted risk', '2026-01-02T00:00:00.000Z'),
            ('sup-u', 'fp-u-open', 'res-u', 'Accepted risk', '2026-01-02T00:00:00.000Z')`,
    `INSERT INTO scan_findings (scan_id, fingerprint, rule_id, severity, title, kind, category, subscription_id, row_count)
     VALUES ('scan-1', 'fp-a-open', '${a}', 'high', 'A finding', 'state', 'reliability', 'sub-1', 1)`,
    `INSERT INTO posture_snapshots (category, subscription_id, date, posture_pct, passing_rules, total_rules, unknown_rules, activity_rule_count, formula_version, active_findings, severity_counts, updated_at)
     VALUES ('reliability', '', '2026-02-01', 50, 1, 2, 0, 0, 2, 3, '{}', '2026-02-01T00:00:00.000Z')`,
  ];
}

/** Admin choices on the rules: enabled state and tags, the things the correction must keep. */
export function adminChoicesSql(): string[] {
  const ids = (list: readonly string[]) => list.map(i => `'${i}'`).join(', ');
  return [
    `UPDATE rules SET enabled = TRUE WHERE id IN (${ids([CHANGED[0], CHANGED[2], UNCHANGED[0]])})`,
    `UPDATE rules SET enabled = FALSE WHERE id IN (${ids([CHANGED[1], CHANGED[3], CHANGED[4], UNCHANGED[1], UNCHANGED[2]])})`,
    `UPDATE rules SET tags = '["mine"]' WHERE id IN (${ids([CHANGED[0], CHANGED[1], UNCHANGED[0]])})`,
  ];
}

/** Every table the correction may or may not touch, as rows in a fixed order. */
export const DUMP_SQL = {
  findings: `SELECT * FROM findings ORDER BY fingerprint`,
  finding_rows: `SELECT * FROM finding_rows ORDER BY fingerprint, position`,
  finding_events: `SELECT * FROM finding_events ORDER BY id`,
  column_catalogue: `SELECT * FROM column_catalogue ORDER BY rule_id, path`,
  suppressions: `SELECT * FROM suppressions ORDER BY id`,
  scan_findings: `SELECT * FROM scan_findings ORDER BY scan_id, fingerprint`,
  posture_snapshots: `SELECT * FROM posture_snapshots ORDER BY category, date`,
  rules: `SELECT * FROM rules ORDER BY id`,
  rule_versions: `SELECT * FROM rule_versions ORDER BY rule_id, version`,
} as const;
export type DumpTable = keyof typeof DUMP_SQL;
