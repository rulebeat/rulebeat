import { createSchedule } from '../db/schedules';
import { loadRules, setRulesEnabled } from '../rules';
import { stampDemoDatabase } from './index';
import { seedDemoVisitor } from './visitor';
import { buildEstate } from './estate';
import { buildIdentityApps } from './identity-fixtures';
import { curateRules } from './curation';
import { replay, TOTAL_DAYS } from './replay';
import { setGeneratorSeed } from './prng';
import { DEMO_HISTORY_ENDS_KEY } from './reset';
import { setMeta } from '../db/meta';
import type { DemoConfig, DemoDataSet } from './config';

// Reached through a dynamic import from ./boot.ts (and the scripts/generate-demo.ts wrapper), never
// statically: every import above resolves down to lib/db/client.ts, which opens its database file
// at module-load time, and the boot step must finish preparing that file first.

async function seedDemoSchedule(): Promise<string> {
  const startAt = new Date();
  startAt.setHours(9, 0, 0, 0);
  const result = await createSchedule({
    name: 'Daily posture scan',
    targetType: 'all',
    targetValues: [],
    recurrenceType: 'daily',
    interval: 1,
    daysOfWeek: null,
    dayOfMonth: null,
    startAt: startAt.toISOString(),
    endType: 'never',
    endDate: null,
    enabled: true,
  });
  if ('error' in result) throw new Error(`Failed to seed demo schedule: ${result.error}`);
  return result.schedule.id;
}

async function generateContoso(): Promise<void> {
  console.log('Building synthetic estate...');
  const estate = buildEstate();
  const identityApps = buildIdentityApps();
  console.log(`  ${estate.resources.length} resources across 4 subscriptions`);

  console.log('Curating rules...');
  const allRules = await loadRules();
  const curation = curateRules(allRules);

  await setRulesEnabled(curation.disabledIds, false);
  await setRulesEnabled(curation.enabledIds, true);
  console.log(`  ${curation.enabledIds.length} rules enabled, ${curation.heldBackIds.length} held back switched off`);

  const fixturesByRuleId = new Map(curation.fixtures.map(f => [f.ruleId, f]));

  console.log('Seeding demo visitor account and schedule...');
  await seedDemoVisitor();
  const scheduleId = await seedDemoSchedule();

  const curatedRules = await loadRules();

  console.log(`Replaying ${TOTAL_DAYS} simulated days of scans...`);
  const historyEndsAt = await replay({
    estate,
    rules: curatedRules,
    fixturesByRuleId,
    identityApps,
    scheduleId,
    onDay: (day, total) => {
      if (day === 0 || (day + 1) % 10 === 0 || day === total - 1) {
        console.log(`  day ${day + 1}/${total}`);
      }
    },
  });
  // Where this history ends, so every Reset can move it to end at the moment of the Reset.
  await setMeta(DEMO_HISTORY_ENDS_KEY, historyEndsAt.toISOString());
}

const DATA_SET_GENERATORS: Record<DemoDataSet, () => Promise<void>> = {
  contoso: generateContoso,
};

/** Fills the freshly opened, empty demo database with the chosen Data set, then stamps it. */
export async function runGenerator(config: DemoConfig): Promise<void> {
  setGeneratorSeed(config.seed);
  console.log(`Generating Demo: Data set ${config.dataSet}, Seed 0x${config.seed.toString(16)}`);
  await DATA_SET_GENERATORS[config.dataSet]();
  await stampDemoDatabase();
  console.log('Demo database generated successfully.');
}
