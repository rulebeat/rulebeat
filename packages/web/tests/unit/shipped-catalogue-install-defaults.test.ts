/**
 * Issue #181: a pack JSON rule may declare its kind. The loader reads the declaration; seeding
 * honours it when the rule is first inserted.
 * Absent means a Problem, and a value that is not a kind a pack may declare is ignored.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dbReady, rawSqlite, pgDb } from '@/lib/db/client';
import { runSeeds } from '@/lib/db/migrate';
import { seedPg } from '@/lib/db/pg/seeds';
import { loadRules } from '@/lib/rules';
import { loadShippedCatalogue, type ShippedCatalogue } from '@/lib/shipped-catalogue';
import { resetDb } from '../helpers/db';

const PACK = 'kind-pack';
const ADVISORY_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const PROBLEM_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const FORGED_ID = 'bbbbbbbb-0000-4000-8000-000000000003';
const REAL_DATA_DIR = join(resolve(__dirname, '..', '..'), 'data');

function entry(id: string, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, name, description: 'A pack rule.', category: 'reliability', severity: 'medium', enabled: true,
    resourceTypes: [], conditions: [], rawKql: 'advisorresources | project id, name', ...extra,
  };
}

/** A data directory holding one pack file, and the catalogue it loads, without RuleBeat Core's rules. */
function packCatalogue(entries: Array<Record<string, unknown>>): ShippedCatalogue {
  const dir = mkdtempSync(join(tmpdir(), 'rb-install-defaults-'));
  mkdirSync(join(dir, 'packs'));
  writeFileSync(join(dir, 'packs', 'pack-manifest.json'), JSON.stringify({ [PACK]: { versionScheme: 'semver', version: '1.0.0' } }));
  writeFileSync(join(dir, 'packs', `${PACK}.json`), JSON.stringify(entries));
  const loaded = loadShippedCatalogue(dir);
  return { ...loaded, rules: loaded.rules.filter(r => r.pack === PACK) };
}

async function seed(catalogue: ShippedCatalogue): Promise<void> {
  await dbReady;
  if (pgDb) await seedPg(pgDb, REAL_DATA_DIR, { skipOwnerBootstrap: true, catalogue });
  else runSeeds(rawSqlite!, REAL_DATA_DIR, { skipOwnerBootstrap: true, catalogue });
}

const stored = async (id: string) => (await loadRules()).find(r => r.id === id)!;

beforeEach(async () => {
  await resetDb();
});

describe('a pack rule that declares its kind', () => {
  const catalogue = () => packCatalogue([
    entry(ADVISORY_ID, 'Pack advisory', { kind: 'advisory' }),
    entry(PROBLEM_ID, 'Pack problem'),
    entry(FORGED_ID, 'Pack forged', { kind: 'activity' }),
  ]);

  it('is read by the loader as an install default, not as part of the versioned definition', () => {
    const rules = catalogue().rules;
    expect(rules.find(r => r.id === ADVISORY_ID)?.installDefaults).toEqual({ kind: 'advisory' });
    expect(rules.find(r => r.id === ADVISORY_ID)?.definition.kind).toBe('state');
    expect(rules.find(r => r.id === PROBLEM_ID)?.installDefaults).toBeUndefined();
  });

  it('is inserted as an Advisory, and a rule that declares nothing as a Problem', async () => {
    await seed(catalogue());
    expect((await stored(ADVISORY_ID)).kind).toBe('advisory');
    expect((await stored(PROBLEM_ID)).kind).toBe('state');
  });

  it('is a Problem when the pack declares a kind a pack may not set', async () => {
    await seed(catalogue());
    expect((await stored(FORGED_ID)).kind).toBe('state');
  });
});
