/**
 * Issue #419: a column lives in the CREATE TABLE of `pg/bootstrap.ts` as well as in its ALTER
 * lines, so a brand-new Postgres database gets it too. Read from the source because the DDL is a
 * module constant; runs on every backend.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as pgSchema from '@/lib/db/schema.pg';

const source = readFileSync(join(resolve(__dirname, '..', '..'), 'lib/db/pg/bootstrap.ts'), 'utf-8');

describe('pg bootstrap CREATE TABLE dashboards', () => {
  it('declares every column schema.pg.ts declares', () => {
    const block = /CREATE TABLE IF NOT EXISTS dashboards \(([\s\S]*?)\n\);/.exec(source)?.[1];
    expect(block, 'CREATE TABLE dashboards not found').toBeDefined();
    const declared = new Set(block!.split('\n').map(l => l.trim().split(/\s+/)[0]));
    const missing = getTableConfig(pgSchema.dashboards).columns.map(c => c.name).filter(n => !declared.has(n));
    expect(missing).toEqual([]);
  });
});
