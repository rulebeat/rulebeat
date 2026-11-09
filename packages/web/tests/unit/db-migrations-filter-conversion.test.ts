/**
 * ADR 0015: the start-up step that turns dashboard filters and saved view queries into Scope picks, on SQLite.
 * The cases are shared with the Postgres twin (pg-bootstrap-filter-conversion.test.ts) in
 * tests/helpers/filter-conversion-cases.ts. Run on a database as 0.13 left it: legacy filters, no Scope picks.
 */
import { afterAll, beforeAll, describe, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { makeSample, open } from '../fixtures/upgrade';
import { runMigrations } from '@/lib/db/migrate';
import { defineFilterConversionCases, type ConversionHarness } from '../helpers/filter-conversion-cases';

let sqlite: Database.Database;

const harness: ConversionHarness = {
  async reset() {
    for (const table of ['findings', 'scan_findings', 'saved_views', 'scope_sets']) sqlite.exec(`DELETE FROM ${table}`);
  },
  async run(statement) { sqlite.exec(statement); },
  async all(statement) { return sqlite.prepare(statement).all() as Record<string, unknown>[]; },
  async startUp() { runMigrations(sqlite); },
};

describe('upgrading dashboard filters and saved views to Scope picks', () => {
  beforeAll(() => {
    sqlite = open(makeSample('current').file);
    runMigrations(sqlite);
  });
  afterAll(() => {
    sqlite.close();
    vi.restoreAllMocks();
  });

  defineFilterConversionCases(() => harness);
});
