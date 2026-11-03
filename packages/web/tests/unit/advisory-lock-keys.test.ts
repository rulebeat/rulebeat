/**
 * Every Postgres advisory lock key lives in a named `*_LOCK_KEY` constant under `lib/`, and the trend record's key
 * is a value no other key uses (ADR 0012: the record lock is taken last, after any name lock, so two keys that
 * shared a value would make a record writer wait on a name lock it does not hold). Sweeps the source under `lib/`
 * the way `tenant-context-takes-access.test.ts` sweeps `app/`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TREND_RECORD_LOCK_KEY } from '@/lib/db/trend-record';

const LIB_DIR = path.resolve(__dirname, '../../lib');

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (/\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

export interface LockKey { name: string; value: number; file: string }

/** Each `const X_LOCK_KEY = <number>` declaration, exported or not. */
export function lockKeysIn(source: string, file: string): LockKey[] {
  const keys: LockKey[] = [];
  const declaration = /\bconst\s+([A-Z][A-Z0-9_]*_LOCK_KEY)\s*(?::\s*number\s*)?=\s*(\d+)\b/g;
  const code = stripComments(source);
  for (let m = declaration.exec(code); m; m = declaration.exec(code)) keys.push({ name: m[1]!, value: Number(m[2]), file });
  return keys;
}

/** Calls that take an advisory lock on a number written out at the call site. */
export function literalLockCalls(source: string): string[] {
  const code = stripComments(source);
  const calls = /\b(?:pgAdvisoryXactLock\s*\(\s*[\w.]+\s*,|pg_(?:try_)?advisory_(?:xact_)?lock\s*\()\s*(\d[\w.]*|['"`][^)]*)/g;
  return [...code.matchAll(calls)].map(m => m[0]);
}

const files = sourceFiles(LIB_DIR).map(file => ({ file: path.relative(LIB_DIR, file), source: readFileSync(file, 'utf-8') }));
const keys = files.flatMap(f => lockKeysIn(f.source, f.file));

describe('the advisory lock keys', () => {
  it('are collected from every file under lib/, the bootstrap key included', () => {
    const names = keys.map(k => k.name);
    for (const known of ['RULE_NAME_LOCK_KEY', 'LIBRARY_REQUEST_LOCK_KEY', 'DASHBOARD_NAME_LOCK_KEY', 'SAVED_VIEW_NAME_LOCK_KEY', 'BOOTSTRAP_LOCK_KEY', 'TREND_RECORD_LOCK_KEY']) {
      expect(names, known).toContain(known);
    }
    expect(keys.length).toBeGreaterThanOrEqual(5);
  });

  it('give the trend record a value no other key uses', () => {
    const trend = keys.filter(k => k.name === 'TREND_RECORD_LOCK_KEY');
    expect(trend).toHaveLength(1);
    expect(trend[0]!.value).toBe(TREND_RECORD_LOCK_KEY);
    expect(keys.filter(k => k.value === TREND_RECORD_LOCK_KEY).map(k => k.name)).toEqual(['TREND_RECORD_LOCK_KEY']);
  });

  // Known bug: DASHBOARD_NAME_LOCK_KEY and LIBRARY_REQUEST_LOCK_KEY are both 7194826034, so a dashboard name write
  // and a Library request write queue behind each other. Fixing one of them removes the marker.
  it.fails('are all distinct', () => {
    const values = keys.map(k => k.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it('are the only way a lock is taken: no advisory lock call passes a number written out', () => {
    expect(files.flatMap(f => literalLockCalls(f.source).map(call => `${f.file}: ${call}`))).toEqual([]);
  });
});

describe('the sweep itself', () => {
  it('reads a key declaration, exported or not, and ignores one in a comment', () => {
    expect(lockKeysIn('export const A_LOCK_KEY = 12;\nconst B_LOCK_KEY = 34;\n// const C_LOCK_KEY = 56;', 'f')).toEqual([
      { name: 'A_LOCK_KEY', value: 12, file: 'f' }, { name: 'B_LOCK_KEY', value: 34, file: 'f' },
    ]);
  });

  it('flags a lock call that passes a number, and passes one that names a key', () => {
    expect(literalLockCalls('await pgAdvisoryXactLock(tx, 7194826033);')).toHaveLength(1);
    expect(literalLockCalls('sql.raw(`SELECT pg_advisory_xact_lock(7194826033)`)')).toHaveLength(1);
    expect(literalLockCalls('await pgAdvisoryXactLock(tx, RULE_NAME_LOCK_KEY);')).toEqual([]);
    expect(literalLockCalls('sql.raw(`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`)')).toEqual([]);
  });
});
