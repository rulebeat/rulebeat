import type { Category, Rule } from './types';
import type { ScheduleTargetType } from './db/schedules';

/** Plain-language description of a target spec (used by schedule rows and Run History alike).
 *  Client-safe — takes already-loaded Category/Rule maps rather than querying the DB itself. */
export function describeTarget(
  target: { targetType: ScheduleTargetType; targetValues: string[] },
  categoryById: Map<string, Category>,
  ruleById: Map<string, Rule>,
): string {
  if (target.targetType === 'all') return 'All categories';
  if (target.targetValues.length === 0) return '—';
  if (target.targetType === 'categories') return target.targetValues.map(v => categoryById.get(v)?.label ?? v).join(', ');
  if (target.targetType === 'tags') return target.targetValues.join(', ');
  const names = target.targetValues.map(v => ruleById.get(v)?.name ?? v);
  return names.length <= 2 ? names.join(', ') : `${names.length} rules`;
}
