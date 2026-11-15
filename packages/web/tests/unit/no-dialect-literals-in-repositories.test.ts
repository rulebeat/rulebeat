/**
 * Dialect drift is handled at the column, never the call site (docs/engineering/conventions/data.md). A literal
 * that only one backend reads (`rowid`, `INDEXED BY`) resolves through lib/db/tables.ts, and no repository
 * statement holds it or branches on the backend to choose it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const LIB = join(__dirname, '..', '..', 'lib');
// The files that are the dialect seam: they choose a backend, they are not repository statements.
const SEAM = new Set(['tables.ts', 'backend.ts', 'client.ts', 'exec.ts', 'migrate.ts', 'schema.ts', 'schema.pg.ts']);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'pg' ? [] : sources(path);
    return entry.name.endsWith('.ts') && !SEAM.has(entry.name) ? [path] : [];
  });
}

describe('repository statements', () => {
  it('hold no SQLite-only literal and do not choose one by backend', () => {
    const offenders = sources(join(LIB, 'db')).filter(path => {
      const text = readFileSync(path, 'utf8');
      return /INDEXED BY/i.test(text) || /\browid\b/.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''));
    });
    expect(offenders).toEqual([]);
  });
});
