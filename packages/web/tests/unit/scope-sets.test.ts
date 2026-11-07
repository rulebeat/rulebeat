/**
 * ADR 0016: a long Scope list travels as `scopeset=<sha256>`. The repository creates a set from a path list
 * and expands a hash back to it; the module beside it decides what a caller may send. Run on whichever
 * backend the suite opened, so the SQLite run and the Postgres run (RULEBEAT_TEST_PG_URL) read the same.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db/client';
import { many } from '@/lib/db/exec';
import { scopeSets } from '@/lib/db/tables';
import { createScopeSet, expandScopeSet } from '@/lib/db/scope-sets';
import { buildAccess, everythingAccess, parseScope, type Access, type ScopeGrant } from '@/lib/access-model';
import { SCOPE_SET_MAX_PATHS, checkScopeSetShape, pathsOutsideAccess, scopeSetHash } from '@/lib/scope-sets';
import { resetDb } from '../helpers/db';

const SUB_A = '/subscriptions/00000000-0000-0000-0000-00000000000a';
const SUB_B = '/subscriptions/00000000-0000-0000-0000-00000000000b';
const RG_ONE = `${SUB_B}/resourceGroups/RG-One`;
const GROUP = '/providers/Microsoft.Management/managementGroups/mg-example';

// Worked by hand: sha256 of the JSON array of the sorted, lower-cased paths.
const HASH_A_AND_RG_ONE = '7aa454dac2c2e178ae8c9e1827e8c8ede345ea2fff82e0f9a9fa83a247c6b9b8';
const HASH_A = 'f63363efa2a6b8edecf9bbb166f0c2d15d8d5a53083838af1ff66e7f06b05c64';

describe('scopeSetHash', () => {
  it('is the sha256 of the sorted, de-duplicated, lower-cased list', () => {
    expect(scopeSetHash([SUB_A, RG_ONE])).toBe(HASH_A_AND_RG_ONE);
    expect(scopeSetHash([RG_ONE.toLowerCase(), SUB_A.toUpperCase(), SUB_A])).toBe(HASH_A_AND_RG_ONE);
    expect(scopeSetHash([SUB_A])).toBe(HASH_A);
  });

  it('does not depend on the order the paths were sent in', () => {
    expect(scopeSetHash([RG_ONE, SUB_A])).toBe(scopeSetHash([SUB_A, RG_ONE]));
  });
});

describe('checkScopeSetShape', () => {
  it('reads a management group, a subscription, a resource group and the Directory', () => {
    const paths = [GROUP, SUB_A, RG_ONE, '@directory'];
    expect(checkScopeSetShape(paths)).toEqual({ ok: true, paths });
  });

  it.each([
    ['Everything', '/'],
    ['a resource', `${RG_ONE}/providers/Microsoft.Compute/virtualMachines/vm-one`],
    ['a trailing slash', `${SUB_A}/`],
    ['an empty string', ''],
    ['text', 'not a scope'],
  ])('refuses %s', (_name, path) => {
    expect(checkScopeSetShape([SUB_A, path])).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a value that is not a string, a list that is not a list, and an empty list', () => {
    expect(checkScopeSetShape([SUB_A, 7])).toEqual({ ok: false, reason: 'malformed' });
    expect(checkScopeSetShape('scope')).toEqual({ ok: false, reason: 'malformed' });
    expect(checkScopeSetShape([])).toEqual({ ok: false, reason: 'malformed' });
  });

  it('accepts a list at the cap and refuses one over it', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `/subscriptions/${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`);
    expect(checkScopeSetShape(many(SCOPE_SET_MAX_PATHS)).ok).toBe(true);
    expect(checkScopeSetShape(many(SCOPE_SET_MAX_PATHS + 1))).toEqual({ ok: false, reason: 'too-many' });
  });

  it('counts the cap on distinct paths, so repeats do not use it up', () => {
    const repeated = Array.from({ length: SCOPE_SET_MAX_PATHS + 5 }, () => SUB_A);
    expect(checkScopeSetShape(repeated).ok).toBe(true);
  });
});

function accessHolding(...paths: string[]): Access {
  const grants: ScopeGrant[] = paths.map(path => ({ tenantId: 't', scope: parseScope(path)!, role: 'viewer' as const }));
  return buildAccess(grants, 'manual');
}

describe('pathsOutsideAccess', () => {
  it('names nothing for Everything', () => {
    expect(pathsOutsideAccess(everythingAccess('admin'), [SUB_A, GROUP, '@directory'])).toEqual([]);
  });

  it('names the paths no held Scope contains, ignoring case', () => {
    const access = accessHolding(SUB_A.toUpperCase());
    expect(pathsOutsideAccess(access, [SUB_A, `${SUB_A}/resourceGroups/rg-in`, SUB_B, '@directory'])).toEqual([SUB_B, '@directory']);
  });

  it('counts what sits under a held management group by the expansion', () => {
    const grants: ScopeGrant[] = [{ tenantId: 't', scope: parseScope(GROUP)!, role: 'viewer' }];
    const access = buildAccess(grants, 'manual', [{ tenantId: 't', path: GROUP, role: 'viewer', groups: ['mg-example'], subscriptions: [SUB_B.split('/')[2]!] }]);
    expect(pathsOutsideAccess(access, [GROUP, SUB_B, RG_ONE, SUB_A])).toEqual([SUB_A]);
  });

  it('skips the paths already stored on the row being saved', () => {
    const access = accessHolding(SUB_A);
    expect(pathsOutsideAccess(access, [SUB_A, SUB_B, RG_ONE], [SUB_B.toUpperCase()])).toEqual([RG_ONE]);
  });
});

describe('createScopeSet and expandScopeSet', () => {
  beforeEach(async () => { await resetDb(); });

  it('stores a set and expands its hash to the paths sent', async () => {
    const made = await createScopeSet([SUB_A, RG_ONE]);
    expect(made.hash).toBe(HASH_A_AND_RG_ONE);
    expect(await expandScopeSet(made.hash)).toEqual({ status: 'resolved', paths: [SUB_A, RG_ONE] });
  });

  it('answers the same hash and keeps one row when the same set is created twice, in any order or casing', async () => {
    const first = await createScopeSet([SUB_A, RG_ONE]);
    const second = await createScopeSet([RG_ONE.toLowerCase(), SUB_A.toUpperCase()]);
    expect(second.hash).toBe(first.hash);
    expect(await many(db.select().from(scopeSets))).toHaveLength(1);
  });

  it('keeps the casing first written', async () => {
    await createScopeSet([SUB_A, RG_ONE]);
    const again = await createScopeSet([SUB_A.toUpperCase(), RG_ONE.toUpperCase()]);
    expect(await expandScopeSet(again.hash)).toEqual({ status: 'resolved', paths: [SUB_A, RG_ONE] });
  });

  it('writes no path twice when the list repeats one with another casing', async () => {
    const made = await createScopeSet([SUB_A, SUB_A.toUpperCase()]);
    expect(await expandScopeSet(made.hash)).toEqual({ status: 'resolved', paths: [SUB_A] });
  });

  it('does not cap a set the server builds itself', async () => {
    const paths = Array.from({ length: SCOPE_SET_MAX_PATHS + 50 }, (_, i) => `/subscriptions/${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`);
    const made = await createScopeSet(paths);
    const expanded = await expandScopeSet(made.hash);
    expect(expanded.status === 'resolved' && expanded.paths.length).toBe(SCOPE_SET_MAX_PATHS + 50);
  });

  it('refuses to store a path that is not a Scope', async () => {
    await expect(createScopeSet([SUB_A, 'not a scope'])).rejects.toThrow();
    expect(await many(db.select().from(scopeSets))).toHaveLength(0);
  });

  it('answers unresolved for a hash with no row, never an empty list', async () => {
    await createScopeSet([SUB_A]);
    expect(await expandScopeSet(HASH_A_AND_RG_ONE)).toEqual({ status: 'unresolved' });
    expect(await expandScopeSet('not a hash')).toEqual({ status: 'unresolved' });
    expect(await expandScopeSet('')).toEqual({ status: 'unresolved' });
  });

  it('finds a set by a hash written in capitals', async () => {
    const made = await createScopeSet([SUB_A]);
    expect(await expandScopeSet(made.hash.toUpperCase())).toEqual({ status: 'resolved', paths: [SUB_A] });
  });

  it('keeps a row when the same set is created again, never rewriting it', async () => {
    const made = await createScopeSet([SUB_A]);
    const [before] = await many(db.select().from(scopeSets));
    await createScopeSet([SUB_A.toUpperCase()]);
    const [after] = await many(db.select().from(scopeSets));
    expect(after).toEqual(before);
    expect(after!.hash).toBe(made.hash);
  });
});
