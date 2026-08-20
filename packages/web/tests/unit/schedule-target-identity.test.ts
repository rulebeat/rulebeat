/**
 * Spec 029 — identity rules are ordinary `rules` table rows now, so a schedule must be able to
 * target them through every targeting mode (direct rule id, tags), not just 'all'/'categories'.
 * Before 029, identity had no rule-engine rows to match tags or ids against at all; the doc comment
 * on resolveRulesForSchedule() in lib/schedule-target.ts now states the wider guarantee this suite
 * pins down.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../helpers/db';
import { loadRules, saveRules } from '@/lib/rules';
import { resolveCategoriesForSchedule, resolveRulesForSchedule } from '@/lib/schedule-target';
import type { ScheduleTargetType } from '@/lib/db/schedules';

const IDENTITY_RULE_ID = 'cred:app-secret-expiring';

function target(targetType: ScheduleTargetType, targetValues: string[]) {
  return { targetType, targetValues };
}

function tagIdentityRule(tag: string): void {
  const all = loadRules();
  const idx = all.findIndex(r => r.id === IDENTITY_RULE_ID);
  expect(idx, `expected the seeded rule ${IDENTITY_RULE_ID} to exist`).toBeGreaterThanOrEqual(0);
  all[idx] = { ...all[idx]!, tags: [tag] };
  saveRules(all);
}

describe('resolveRulesForSchedule reaches identity rules through every targeting mode (spec 029)', () => {
  beforeEach(() => {
    resetDb();
  });

  it("'rules' targeting matches an identity rule by direct id", () => {
    const resolved = resolveRulesForSchedule(target('rules', [IDENTITY_RULE_ID]));
    expect(resolved.map(r => r.id)).toEqual([IDENTITY_RULE_ID]);
  });

  it("'categories' targeting includes identity rules under the identity category", () => {
    const resolved = resolveRulesForSchedule(target('categories', ['identity']));
    expect(resolved.map(r => r.id)).toContain(IDENTITY_RULE_ID);
  });

  it("'all' targeting includes identity rules", () => {
    const resolved = resolveRulesForSchedule(target('all', []));
    expect(resolved.map(r => r.id)).toContain(IDENTITY_RULE_ID);
  });

  it("'tags' targeting matches an identity rule carrying the selected tag", () => {
    tagIdentityRule('mcsb:identity');
    const resolved = resolveRulesForSchedule(target('tags', ['mcsb:identity']));
    expect(resolved.map(r => r.id)).toEqual([IDENTITY_RULE_ID]);
  });

  it('resolveCategoriesForSchedule reports identity when a tags-based schedule resolves to an identity rule', () => {
    tagIdentityRule('mcsb:identity');
    const categories = resolveCategoriesForSchedule(target('tags', ['mcsb:identity']));
    expect(categories).toEqual(['identity']);
  });
});
