import { eq } from 'drizzle-orm';
import { db } from '../../lib/db/client';
import { users } from '../../lib/db/schema';
import { createUser } from '../../lib/db/users';
import { createSchedule } from '../../lib/db/schedules';
import { loadRules, setRulesEnabled } from '../../lib/rules';
import { DEMO_VISITOR_ID, stampDemoDatabase } from '../../lib/demo';
import { buildEstate } from './estate';
import { buildIdentityApps } from './identity-fixtures';
import { CORE_FIXTURES, CORE_RULE_IDS } from './core-fixtures';
import { buildAprlFixtures } from './aprl-fixtures';
import type { RuleFixture } from './rule-fixture';
import { replay, TOTAL_DAYS } from './replay';

// This module must only ever be reached via the dynamic `import('./demo/run')` in
// scripts/generate-demo.ts, *after* that file has set `RULEBEAT_DEMO=1` — every import above
// resolves down to lib/db/client.ts, which reads that env var at module-load time to decide
// rulebeat.db vs demo.db. A static top-level import here would be hoisted ahead of the env-var
// assignment and silently open the real database instead.

function seedDemoVisitor(): void {
  const result = createUser({ email: 'demo-visitor@rulebeat.local', role: 'viewer' });
  if ('error' in result) throw new Error(`Failed to seed demo visitor: ${result.error}`);
  db.update(users).set({ id: DEMO_VISITOR_ID }).where(eq(users.id, result.user.id)).run();
}

function seedDemoSchedule(): string {
  const startAt = new Date();
  startAt.setHours(9, 0, 0, 0);
  const result = createSchedule({
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

export async function runGenerator(): Promise<void> {
  console.log('Building synthetic estate...');
  const estate = buildEstate();
  const identityApps = buildIdentityApps();
  console.log(`  ${estate.resources.length} resources across 4 subscriptions`);

  console.log('Curating rules...');
  const allRules = loadRules();
  const aprlRuleIds = allRules.filter(r => r.pack === 'aprl-v2').map(r => r.id);
  const aprlFixtures = buildAprlFixtures(allRules);

  // Reset every APRL rule to disabled, then enable exactly the curated, fixture-backed subset —
  // never trust whatever subset shipped enabled-by-default, since it wasn't chosen with this
  // estate's resource types in mind.
  setRulesEnabled(aprlRuleIds, false);
  setRulesEnabled(aprlFixtures.map(f => f.ruleId), true);
  setRulesEnabled(CORE_RULE_IDS, true);
  console.log(`  ${CORE_RULE_IDS.length} core rules + ${aprlFixtures.length} APRL rules enabled`);

  const fixtures: RuleFixture[] = [...CORE_FIXTURES, ...aprlFixtures];
  const fixturesByRuleId = new Map(fixtures.map(f => [f.ruleId, f]));

  console.log('Seeding demo visitor account and schedule...');
  seedDemoVisitor();
  const scheduleId = seedDemoSchedule();

  const curatedRules = loadRules();

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

  stampDemoDatabase();
  console.log('Demo database generated successfully.');
}
