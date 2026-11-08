/**
 * The Rules tab's address (#402). Every filter the list reads is a param here, and this is the one place
 * a query is turned into params and back: the Scans page reads the address with
 * `rulesQueryFromSearchParams`, the filter controls write it with `rulesQueryToSearchParams`, so the
 * server's list and the controls cannot drift. Only free-text search stays in the browser.
 *
 *  - `category`, `source` (a rule's pack, else its type), `tags`, `severity`: comma lists, any match.
 *  - `kind`: `problem`, `advisory` or `activity`.
 *  - `outcome`: `passing`, `failing`, `unknown` or `checked`, the Outcome at the Scope below.
 *  - `rules`: `enabled`, `disabled` or `all` (the default, so an older link is unchanged).
 *  - The Scope the Outcome is read at: `subscription` (an id, or `directory`), `rg` (resource group names,
 *    which need a `subscription`) and `managementGroup`. They hide no rule.
 *
 * Anything unknown or malformed is ignored rather than rejected, so an old or hand-edited link still
 * opens. Client-safe: no Node, no database.
 */
import type { RuleKind, Severity } from '@/lib/types';
import { EXPLORER_SEVERITIES } from '@/lib/explorer-filters';
import { esc, readParam, splitList, type ParamSource } from '@/lib/finding-view';
import { RULE_OUTCOMES, type RuleOutcome } from '@/lib/rule-outcome';
import { parseCategoryParam } from '@/lib/scans-link';

export const RULES_KINDS = ['problem', 'advisory', 'activity'] as const;
export type RulesKind = (typeof RULES_KINDS)[number];

export const RULES_ENABLED = ['enabled', 'disabled', 'all'] as const;
export type RulesEnabled = (typeof RULES_ENABLED)[number];

export interface RulesTabQuery {
  categories: string[];
  sources: string[];
  tags: string[];
  severities: Severity[];
  subscriptions: string[];
  resourceGroups: string[];
  managementGroups: string[];
  kind?: RulesKind;
  outcome?: RuleOutcome;
  rules: RulesEnabled;
}

export const EMPTY_RULES_QUERY: RulesTabQuery = Object.freeze({
  categories: [], sources: [], tags: [], severities: [], subscriptions: [], resourceGroups: [], managementGroups: [], rules: 'all',
}) as RulesTabQuery;

/** The params the Rules tab owns, in the order they are written. */
const OWN_PARAMS = ['category', 'source', 'tags', 'severity', 'subscription', 'rg', 'managementGroup', 'kind', 'outcome', 'rules'] as const;

/** A rule kind as the address names it: a Problem rule is `state` in storage. */
const KIND_OF: Record<RulesKind, RuleKind> = { problem: 'state', advisory: 'advisory', activity: 'activity' };
export const storedKind = (kind: RulesKind): RuleKind => KIND_OF[kind];

function oneOf<T extends string>(allowed: readonly T[], value: string | undefined): T | undefined {
  return allowed.find(a => a === value);
}

export function rulesQueryFromSearchParams(source: ParamSource): RulesTabQuery {
  return {
    categories: parseCategoryParam(readParam(source, 'category')),
    sources: splitList(readParam(source, 'source')),
    tags: splitList(readParam(source, 'tags')),
    severities: splitList(readParam(source, 'severity')).filter((s): s is Severity => (EXPLORER_SEVERITIES as string[]).includes(s)),
    subscriptions: splitList(readParam(source, 'subscription')),
    resourceGroups: splitList(readParam(source, 'rg')),
    managementGroups: splitList(readParam(source, 'managementGroup')),
    kind: oneOf(RULES_KINDS, readParam(source, 'kind')),
    outcome: oneOf(RULE_OUTCOMES, readParam(source, 'outcome')),
    rules: oneOf(RULES_ENABLED, readParam(source, 'rules')) ?? 'all',
  };
}

/** The query as params, with `base` (params the page itself owns, such as `tab`) kept first. A param the query
 *  does not hold is removed from `base`, and a default is left out. */
export function rulesQueryToSearchParams(query: RulesTabQuery, base?: URLSearchParams): URLSearchParams {
  const params = new URLSearchParams();
  base?.forEach((value, name) => { if (!(OWN_PARAMS as readonly string[]).includes(name)) params.append(name, value); });
  const list = (name: string, values: readonly string[]) => { if (values.length > 0) params.set(name, values.map(esc).join(',')); };
  list('category', query.categories);
  list('source', query.sources);
  list('tags', query.tags);
  list('severity', query.severities);
  list('subscription', query.subscriptions);
  list('rg', query.resourceGroups);
  list('managementGroup', query.managementGroups);
  if (query.kind) params.set('kind', query.kind);
  if (query.outcome) params.set('outcome', query.outcome);
  if (query.rules !== 'all') params.set('rules', query.rules);
  return params;
}

/** Whether any parameter that hides a rule is set. The Scope is not one: it only sets where the Outcome is read. */
export function hasRulesFilter(query: RulesTabQuery): boolean {
  return query.categories.length > 0 || query.sources.length > 0 || query.tags.length > 0 || query.severities.length > 0
    || query.kind !== undefined || query.outcome !== undefined || query.rules !== 'all';
}
