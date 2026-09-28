import { createSchedule } from '../db/schedules';
import { loadRules, setRulesEnabled } from '../rules';
import { stampDemoDatabase } from './index';
import { seedDemoVisitor } from './visitor';
import { buildEstate } from './estate';
import { buildIdentityApps } from './identity-fixtures';
import { CORE_FIXTURES, CORE_RULE_IDS } from './core-fixtures';
import { buildAprlFixtures } from './aprl-fixtures';
import type { RuleFixture } from './rule-fixture';
import { replay, TOTAL_DAYS } from './replay';
import { setGeneratorSeed } from './prng';
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
  const aprlRuleIds = allRules.filter(r => r.pack === 'aprl-v2').map(r => r.id);
  const aprlFixtures = buildAprlFixtures(allRules);

  // Reset every APRL rule to disabled, then enable exactly the curated, fixture-backed subset —
  // never trust whatever subset shipped enabled-by-default, since it wasn't chosen with this
  // estate's resource types in mind.
  await setRulesEnabled(aprlRuleIds, false);
  await setRulesEnabled(aprlFixtures.map(f => f.ruleId), true);
  await setRulesEnabled(CORE_RULE_IDS, true);
  console.log(`  ${CORE_RULE_IDS.length} core rules + ${aprlFixtures.length} APRL rules enabled`);

  const fixtures: RuleFixture[] = [...CORE_FIXTURES, ...aprlFixtures];
  const fixturesByRuleId = new Map(fixtures.map(f => [f.ruleId, f]));

  console.log('Seeding demo visitor account and schedule...');
  await seedDemoVisitor();
  const scheduleId = await seedDemoSchedule();

  const curatedRules = await loadRules();

  console.log(`Replaying ${TOTAL_DAYS} simulated days of scans...`);
  await replay({
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
