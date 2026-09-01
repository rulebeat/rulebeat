import { loadRules } from './rules';
import { listCategories } from './db/categories';
import { listSchedules, type Schedule } from './db/schedules';
import type { Rule } from './types';

/** Resolves a schedule's target into the concrete set of enabled rules it covers.
 *  'all'/'categories' resolve by rule.category; 'tags' matches any rule carrying one of the
 *  selected tags; 'rules' is a direct id allowlist. Identity rules are ordinary rows like any
 *  other, so they're reachable through every targeting mode, not just 'all'/'categories'. */
export async function resolveRulesForSchedule(schedule: Pick<Schedule, 'targetType' | 'targetValues'>): Promise<Rule[]> {
  const enabledRules = (await loadRules()).filter(r => r.enabled) as unknown as Rule[];

  switch (schedule.targetType) {
    case 'all':
      return enabledRules;
    case 'categories':
      return enabledRules.filter(r => schedule.targetValues.includes(r.category));
    case 'tags':
      return enabledRules.filter(r => (r.tags ?? []).some(t => schedule.targetValues.includes(t)));
    case 'rules':
      return enabledRules.filter(r => schedule.targetValues.includes(r.id));
  }
}

/** Category ids a schedule will actually touch when it runs — used both to execute a run
 *  (per-category grouping) and to answer "does this schedule cover category X". */
export async function resolveCategoriesForSchedule(schedule: Pick<Schedule, 'targetType' | 'targetValues'>): Promise<string[]> {
  if (schedule.targetType === 'all') return (await listCategories()).map(c => c.id);
  if (schedule.targetType === 'categories') {
    const known = new Set((await listCategories()).map(c => c.id));
    return schedule.targetValues.filter(v => known.has(v));
  }
  // tags / rules — derive from the resolved rule set
  return [...new Set((await resolveRulesForSchedule(schedule)).map(r => r.category))];
}

export async function getNextRunForCategory(slug: string): Promise<string | null> {
  const candidates: string[] = [];
  for (const s of await listSchedules()) {
    if (!s.enabled || s.nextRunAt === null) continue;
    if ((await resolveCategoriesForSchedule(s)).includes(slug)) candidates.push(s.nextRunAt);
  }
  if (candidates.length === 0) return null;
  return candidates.reduce((min, cur) => (cur < min ? cur : min));
}
