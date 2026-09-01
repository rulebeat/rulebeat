/**
 * TS-25 · a recording of exactly what the upgrade does to each sample database.
 *
 * This suite asserts almost nothing about *correctness*. Its job is to be a tripwire: it drives the
 * product's real startup path over every sample shape and snapshots the resulting database, so that
 * any change to the upgrade code which was supposed to be behaviour-preserving can be proven so.
 *
 * It is the reference the migration extraction was carried out against. Keep it: the snapshots are a
 * human-readable, diffable record of the current behaviour, including the behaviour that is wrong —
 * the bugs the rest of the suite pins are visible in here too, and fixing one is *supposed* to
 * produce a snapshot diff. An unexplained diff, on the other hand, means something moved that
 * shouldn't have.
 */
import { describe, expect, it } from 'vitest';
import { SHAPES } from '../fixtures/db-shapes';
import { makeSample, open, upgradeInProcess, upgradeViaStartup } from '../fixtures/upgrade';
import { dumpDb } from '../fixtures/dump';

function upgradedDump(shape: (typeof SHAPES)[number], how: 'startup' | 'in-process'): string {
  const sample = makeSample(shape);
  if (how === 'startup') upgradeViaStartup(sample);
  else upgradeInProcess(sample);

  const sqlite = open(sample.file);
  const dump = dumpDb(sqlite);
  sqlite.close();
  return dump;
}

describe('TS-25 · the upgrade produces a recorded, stable result', () => {
  for (const shape of SHAPES) {
    it(`25-02 · ${shape} upgrades to a known state`, async () => {
      expect(upgradedDump(shape, 'startup')).toMatchSnapshot();
    }, 60_000);
  }
});

describe('TS-25 · calling the migrations directly is the same as starting the app', () => {
  /**
   * The premise every other test in the upgrade suite rests on. Those tests call `runMigrations` and
   * `runSeeds` directly because it is fast and lets them construct half-migrated states — but that is
   * only meaningful if it does what actually happens when someone starts RuleBeat, which goes through
   * `lib/db/client.ts` opening its connection at import time.
   *
   * Asserted per shape rather than once, because the shapes exercise different migrations: an
   * ordering difference between the two paths could show up in one lineage and not another.
   */
  for (const shape of SHAPES) {
    it(`25-02 · ${shape} ends up identical either way`, async () => {
      expect(upgradedDump(shape, 'in-process')).toBe(upgradedDump(shape, 'startup'));
    }, 60_000);
  }
});
