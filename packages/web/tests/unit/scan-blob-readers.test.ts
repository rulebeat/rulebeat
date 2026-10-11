/**
 * Issue #219: nothing in the product reads a scan's findings blob any more. A past run reads its
 * `scan_findings` records (ADR 0008), and the blob is written empty and emptied by the upgrade. The only
 * readers left are the upgrade itself, which converts a blob that has no records yet, and the reader the
 * two one-time backfills replay history through. A new reader anywhere else would read empty history
 * on every database the upgrade has emptied, so this fails until it is removed or listed here with a reason.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const ALLOWED = new Set([
  'lib/db/migrate.ts',           // converts a blob that has no records yet, and empties it once it has
  'lib/db/pg/bootstrap.ts',      // the same on Postgres
  'lib/db/scan-blob-history.ts', // what the two one-time backfills replay history from
]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name.startsWith('.') ? [] : sources(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

/** What reads the blob: its column through Drizzle, a whole scans row, or the column in raw SQL. */
function readsBlob(text: string): boolean {
  const alias = text.match(/\bscans as (\w+)\b[^;]*from '[^']*tables'/)?.[1]
    ?? (/\{[^}]*\bscans\b[^}]*\}\s*from '[^']*tables'/.test(text) ? 'scans' : null);
  if (alias !== null) {
    if (new RegExp(`\\b${alias}\\.findings\\b`).test(text)) return true;
    if (new RegExp(`\\.select\\(\\)\\s*\\.from\\(${alias}\\)`).test(text)) return true;
  }
  return /\bfindings\s+FROM\s+scans\b|SELECT\s+\*\s+FROM\s+scans\b/i.test(text);
}

describe('the findings blob', () => {
  it('is read only by the upgrade and the backfills\' own reader', () => {
    const readers = ['lib', 'app'].flatMap(dir => sources(join(WEB, dir)))
      .filter(path => readsBlob(readFileSync(path, 'utf8')))
      .map(path => relative(WEB, path).split(sep).join('/'));
    expect(readers.filter(path => !ALLOWED.has(path))).toEqual([]);
    // Each allowed reader still is one, so a reader that goes also leaves this list.
    expect(readers.sort()).toEqual([...ALLOWED].sort());
  });
});
