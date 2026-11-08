/**
 * #402: a column lives in five places (conventions/data.md), and a fresh Postgres database is made only by the
 * `CREATE TABLE` in `pg/bootstrap.ts`. The pg-only column comparison runs on the Postgres CI job, so this reads
 * the bootstrap script on any run: the `CREATE TABLE` itself declares the columns #402 added, not only an
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for databases that predate them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(join(__dirname, '../../lib/db/pg/bootstrap.ts'), 'utf8');

function createTableBody(table: string): string {
  const start = SOURCE.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  expect(start, `no CREATE TABLE for ${table}`).toBeGreaterThanOrEqual(0);
  return SOURCE.slice(start, SOURCE.indexOf('\n);', start));
}

describe('the Postgres CREATE TABLE declares the columns #402 added', () => {
  it.each([
    ['scans', 'ran_rule_ids'],
    ['rules', 'enabled_at'],
  ])('%s has %s', (table, column) => {
    expect(createTableBody(table)).toMatch(new RegExp(`\\n\\s+${column} TEXT\\b`));
  });

  it('still adds both to a database bootstrapped before them', () => {
    expect(SOURCE).toContain('ALTER TABLE scans ADD COLUMN IF NOT EXISTS ran_rule_ids TEXT;');
    expect(SOURCE).toContain('ALTER TABLE rules ADD COLUMN IF NOT EXISTS enabled_at TEXT;');
  });
});
