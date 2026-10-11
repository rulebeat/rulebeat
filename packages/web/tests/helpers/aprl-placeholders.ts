/**
 * Shared by the SQLite and Postgres tests of the placeholder-rule removal (#222): what a database
 * held while the APRL pack still shipped two rules whose query is only `// under-development`.
 *
 * `tests/fixtures/aprl-v2-before-222.json` is those two entries of the old `aprl-v2.json`, saved
 * before the pack was regenerated.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadShippedCatalogue, type ShippedCatalogue } from '@/lib/shipped-catalogue';
import { REAL_DATA_DIR } from './aprl-correction';

export const ENABLED_PLACEHOLDER = '98bd7098-49d6-491b-86f1-b143d6b1a0ff';
export const DISABLED_PLACEHOLDER = 'b60ae773-9917-4bca-8a42-7cb45365a917';
export const PLACEHOLDERS = [ENABLED_PLACEHOLDER, DISABLED_PLACEHOLDER] as const;

export const placeholderEntries = () =>
  JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'aprl-v2-before-222.json'), 'utf-8')) as Array<{ id: string; rawKql: string }>;

/** What this build shipped before the fix: Core plus the two placeholder APRL rules. */
export function oldPlaceholderCatalogue(): ShippedCatalogue {
  const dir = mkdtempSync(join(tmpdir(), 'rb-aprl-placeholders-'));
  mkdirSync(join(dir, 'packs'));
  cpSync(join(REAL_DATA_DIR, 'packs', 'pack-manifest.json'), join(dir, 'packs', 'pack-manifest.json'));
  writeFileSync(join(dir, 'packs', 'aprl-v2.json'), JSON.stringify(placeholderEntries()));
  return loadShippedCatalogue(dir);
}

/** One enabled and tagged placeholder rule, one disabled. */
export function placeholderChoicesSql(): string[] {
  return [
    `UPDATE rules SET enabled = TRUE, tags = '["mine"]' WHERE id = '${ENABLED_PLACEHOLDER}'`,
    `UPDATE rules SET enabled = FALSE WHERE id = '${DISABLED_PLACEHOLDER}'`,
  ];
}

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

/** Open and fixed findings with their rows and events, and suppressions, on both placeholder rules. */
export function placeholderPopulationSql(): string[] {
  return [
    ...findingSql(ENABLED_PLACEHOLDER, 'p1-open', 'active'),
    ...findingSql(ENABLED_PLACEHOLDER, 'p1-fixed', 'fixed'),
    ...findingSql(DISABLED_PLACEHOLDER, 'p2-fixed', 'fixed'),
    `INSERT INTO suppressions (id, fingerprint, resource_id, reason, suppressed_at)
     VALUES ('sup-p1', 'fp-p1-open', 'res-p1', 'Accepted risk', '2026-01-02T00:00:00.000Z'),
            ('sup-p2', 'fp-p2-fixed', 'res-p2', 'Accepted risk', '2026-01-02T00:00:00.000Z')`,
  ];
}

/** The tables the upgrade must leave alone, in a fixed order. */
export const KEPT_SQL = {
  findings: `SELECT * FROM findings ORDER BY fingerprint`,
  finding_rows: `SELECT * FROM finding_rows ORDER BY fingerprint, position`,
  finding_events: `SELECT * FROM finding_events ORDER BY id`,
  suppressions: `SELECT * FROM suppressions ORDER BY id`,
} as const;
export type KeptTable = keyof typeof KEPT_SQL;

/** The columns of a rule row that the retirement must not change. */
export const RULE_KEPT_COLUMNS = ['id', 'enabled', 'tags', 'version', 'raw_kql', 'type', 'pack'] as const;
