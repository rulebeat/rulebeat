/**
 * The Rules tab's filters as they travel in the link: `category`, `status` (enabled or disabled),
 * `lastRun` (a `|` list of success, failed, capped, invalid, not-run) and `reach=yours`. Pure, no DB or
 * Node imports, so the page, the client and the Scan Coverage widget share one reading, one writing and
 * one test of "does this rule show", and the count the widget links from is the length of the list it opens.
 *
 * `status` is also the Results tab's own param (open, new, fixed, all). The Rules tab reads only its two
 * values and, when writing, touches `status` only for them, so switching tabs keeps the other's choice.
 * Tag and severity stay local to the tab and are not in the link.
 */
import { parseCategoryParam } from './scans-link';

export type RuleLastRun = 'success' | 'failed' | 'capped' | 'invalid' | 'not-run';
export type RuleStatusFilter = 'all' | 'enabled' | 'disabled';

export const RULE_LAST_RUNS: readonly RuleLastRun[] = ['success', 'failed', 'capped', 'invalid', 'not-run'];

/** The last runs that did not finish: what makes a category partial on Scan Coverage. A rule that never ran is not one. */
export const INCOMPLETE_LAST_RUNS: readonly RuleLastRun[] = ['failed', 'capped', 'invalid'];

export interface RulesTabFilter {
  status: RuleStatusFilter;
  lastRun: RuleLastRun[];
  /** Only the rules that look at what the person holds. Ignored for Everything, who has no such set. */
  reach: boolean;
  categories: string[];
}

export const EMPTY_RULES_FILTER: RulesTabFilter = Object.freeze({
  status: 'all', lastRun: [], reach: false, categories: [],
}) as RulesTabFilter;

type ParamSource = URLSearchParams | Record<string, string | string[] | undefined>;

function readParam(source: ParamSource, name: string): string | undefined {
  if (source instanceof URLSearchParams) return source.get(name) ?? undefined;
  const raw = source[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

export function readRulesTabFilter(source: ParamSource): RulesTabFilter {
  const status = readParam(source, 'status');
  const lastRun = (readParam(source, 'lastRun') ?? '').split('|').filter((v): v is RuleLastRun => (RULE_LAST_RUNS as readonly string[]).includes(v));
  return {
    status: status === 'enabled' || status === 'disabled' ? status : 'all',
    lastRun: [...new Set(lastRun)],
    reach: readParam(source, 'reach') === 'yours',
    categories: parseCategoryParam(readParam(source, 'category')),
  };
}

/** `query` with the four filters set to `filter`, and every other param as it was. */
export function writeRulesTabFilter(query: string, filter: RulesTabFilter): string {
  const params = new URLSearchParams(query);
  if (filter.status !== 'all') params.set('status', filter.status);
  else if (params.get('status') === 'enabled' || params.get('status') === 'disabled') params.delete('status');
  if (filter.lastRun.length) params.set('lastRun', filter.lastRun.join('|'));
  else params.delete('lastRun');
  if (filter.reach) params.set('reach', 'yours');
  else params.delete('reach');
  if (filter.categories.length) params.set('category', filter.categories.join(','));
  else params.delete('category');
  return params.toString();
}

/** The link to the Rules tab with `filter` applied. */
export function rulesTabHref(filter: RulesTabFilter): string {
  return `/scans?${writeRulesTabFilter('tab=rules', filter)}`;
}

export function lastRunOf(rule: { lastRunStatus?: 'success' | 'failed' | 'capped' | 'invalid' }): RuleLastRun {
  return rule.lastRunStatus ?? 'not-run';
}

/**
 * Whether a rule shows under `filter`. `reachRuleIds` is the set of rules that look at what the person
 * holds (`lib/rule-overlap.ts`), given only to someone without Everything; without it the reach filter
 * keeps every rule.
 */
export function matchesRulesTabFilter(
  rule: { id: string; category: string; enabled: boolean; lastRunStatus?: 'success' | 'failed' | 'capped' | 'invalid' },
  filter: RulesTabFilter, reachRuleIds?: ReadonlySet<string>,
): boolean {
  if (filter.status === 'enabled' && !rule.enabled) return false;
  if (filter.status === 'disabled' && rule.enabled) return false;
  if (filter.categories.length > 0 && !filter.categories.includes(rule.category)) return false;
  if (filter.lastRun.length > 0 && !filter.lastRun.includes(lastRunOf(rule))) return false;
  if (filter.reach && reachRuleIds && !reachRuleIds.has(rule.id)) return false;
  return true;
}

/**
 * The link Scan Coverage's incomplete-rule count opens: the category's enabled rules whose last run did not
 * finish, and, for anyone without Everything, only those that look at what they hold, since the count is
 * narrowed the same way.
 */
export function incompleteRulesHref(category: string, holdsEverything: boolean): string {
  return rulesTabHref({ status: 'enabled', lastRun: [...INCOMPLETE_LAST_RUNS], reach: !holdsEverything, categories: [category] });
}
