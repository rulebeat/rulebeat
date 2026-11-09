/**
 * What the Results, Advisories and Activity tabs know about the values of a view's filters that the
 * address alone does not say: how each Scope pick sits against the viewer's Access, whether a Rule source,
 * tag or category still exists, and how a chip reads for each. The server works the states out
 * (lib/db/view-filters.ts) and the explorer draws these words, so the two cannot word a chip differently.
 * Client-safe: no Node, no database.
 */
import type { AgeRange } from './finding-view';
import { managementGroupIdOf, parseScope } from './access-model';
import { packSourceLabel, type PackManifestLabels } from './pack-labels';

/** How one Scope pick sits against the viewer's Access (ADR 0015):
 *  - `held`: the viewer holds all of it, so it is named;
 *  - `narrowed`: a subscription they hold only in part, still named;
 *  - `outside-narrowed`: a pick they hold only in part and cannot read the name of (a management group);
 *  - `outside`: none of it is theirs, so it is counted and never named, and matches nothing;
 *  - `unresolved`: the upgrade could not turn an old value into a Scope. It names no Scope, so there is nothing
 *    to hide: it is named by the old filter's own words, marked as no longer existing, and matches nothing. */
export type ScopePickAccess = 'held' | 'narrowed' | 'outside-narrowed' | 'outside' | 'unresolved';

export interface ScopePickState {
  /** The pick as the address holds it. */
  value: string;
  access: ScopePickAccess;
  /** What the pick is called. Null when the viewer may not be told. */
  label: string | null;
}

export interface SourceValueState {
  value: string;
  label: string;
  /** False for a pack no rule carries any more. */
  exists: boolean;
}

/** How many picks of a Scope set the server left out of `FilterStates.scope`: those the viewer holds none of, and
 *  those they hold in part and may not read the name of. A set is opened only on the server, and its picks are
 *  the author's to know, so what the viewer does not hold is counted and its path never sent (ADR 0016). */
export interface HiddenScopePicks {
  outside: number;
  outsideNarrowed: number;
}

export interface FilterStates {
  scope: ScopePickState[];
  /** Picks of a `scopeset=` that `scope` does not carry. Always zero for an inline list, which the address names. */
  scopeHidden: HiddenScopePicks;
  /** The `scopeset=` reference could not be opened here, so the Scope filter matches nothing. */
  scopeUnresolved: boolean;
  source: SourceValueState[];
  /** Tags in the filter that no rule carries. They match nothing. */
  missingTags: string[];
  /** Categories in the filter that were deleted. They still match the findings recorded under them. */
  deletedCategories: string[];
}

export const NO_FILTER_STATES: FilterStates = Object.freeze({
  scope: Object.freeze([]) as unknown as ScopePickState[],
  scopeHidden: Object.freeze({ outside: 0, outsideNarrowed: 0 }),
  scopeUnresolved: false,
  source: Object.freeze([]) as unknown as SourceValueState[],
  missingTags: Object.freeze([]) as unknown as string[],
  deletedCategories: Object.freeze([]) as unknown as string[],
});

export const COMMUNITY_SOURCE = 'community';
export const CUSTOM_SOURCE = 'custom';

export const NARROWED_NOTE = 'narrowed to what you hold';
export const NO_LONGER_EXISTS = 'no longer exists';
export const DELETED_NOTE = 'deleted';
export const NOT_FOUND_IN_AZURE = 'Not found in Azure';

/** What a Rule source value is called: a pack by the manifest's label, else its built-in label, else its id. */
export function sourceLabel(value: string, manifest: PackManifestLabels = {}): string {
  if (value === COMMUNITY_SOURCE) return 'Community';
  if (value === CUSTOM_SOURCE) return 'Custom';
  return packSourceLabel(value, manifest);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The chip for an age range: "First seen 31 to 90 days ago". */
export function ageChipLabel(age: AgeRange): string {
  if (age.max === null) return `First seen ${plural(age.min, 'day', 'days')} ago or more`;
  if (age.max === age.min) return `First seen ${plural(age.min, 'day', 'days')} ago`;
  return `First seen ${age.min} to ${plural(age.max, 'day', 'days')} ago`;
}

/** One chip of the Scope filter. `values` are the picks it stands for, which removing the chip drops. */
export interface ScopeChip {
  key: string;
  label: string;
  values: string[];
}

/** What the latest listing of the stored tree says: whether it could be read, and the lower-case path of every
 *  management group and subscription it holds. */
export interface ScopeListing {
  failed: boolean;
  known: ReadonlySet<string>;
}

/** A Scope by its id alone, the way a pick reads when no name can be trusted. Not `scope-picks.ts`, which this module
 *  cannot import: the startup upgrade reaches this file by relative paths and that one reaches for `@/`. */
function idLabel(path: string): string {
  const parts = path.split('/');
  switch (parseScope(path)?.kind) {
    case 'directory': return 'Directory';
    case 'managementGroup': return managementGroupIdOf(path);
    case 'subscription': return parts[2]!;
    case 'resourceGroup': return `${parts[4]} in ${parts[2]}`;
    default: return path;
  }
}

/** What a held pick is called against the listing: its name; its id alone when the listing failed, since the name
 *  may be stale; and its name marked when the listing is sound and does not know it. Only a management group and
 *  a subscription are marked, since the listing does not enumerate resource groups or the Directory. */
function listedLabel(pick: ScopePickState, listing: ScopeListing | undefined): string {
  const name = pick.label ?? pick.value;
  if (!listing) return name;
  if (listing.failed) return idLabel(pick.value);
  const kind = parseScope(pick.value)?.kind;
  const listable = kind === 'managementGroup' || kind === 'subscription';
  return listable && !listing.known.has(pick.value.toLowerCase()) ? markedLabel(name, NOT_FOUND_IN_AZURE) : name;
}

/**
 * The chips a Scope filter shows. A pick the viewer holds is named, a partly held subscription says it is
 * narrowed, and picks the viewer may not be told the name of are counted in a chip of their own, never
 * named: "2 Scopes outside your access", or "1 Scope outside your access, narrowed to what you hold" for
 * those they hold a part of.
 */
export function scopeChips(
  picks: readonly ScopePickState[], listing?: ScopeListing, hidden: HiddenScopePicks = NO_FILTER_STATES.scopeHidden,
): ScopeChip[] {
  const chips: ScopeChip[] = [];
  for (const pick of picks) {
    if (pick.access === 'held') chips.push({ key: pick.value, label: listedLabel(pick, listing), values: [pick.value] });
    else if (pick.access === 'narrowed') chips.push({ key: pick.value, label: markedLabel(listedLabel(pick, listing), NARROWED_NOTE), values: [pick.value] });
    else if (pick.access === 'unresolved') chips.push({ key: pick.value, label: markedLabel(pick.label ?? pick.value, NO_LONGER_EXISTS), values: [pick.value] });
  }
  const outside = picks.filter(p => p.access === 'outside');
  const outsideCount = outside.length + hidden.outside;
  if (outsideCount > 0) {
    chips.push({ key: 'outside', label: `${plural(outsideCount, 'Scope', 'Scopes')} outside your access`, values: outside.map(p => p.value) });
  }
  const narrowedOutside = picks.filter(p => p.access === 'outside-narrowed');
  const narrowedCount = narrowedOutside.length + hidden.outsideNarrowed;
  if (narrowedCount > 0) {
    chips.push({
      key: 'outside-narrowed',
      label: `${plural(narrowedCount, 'Scope', 'Scopes')} outside your access, ${NARROWED_NOTE}`,
      values: narrowedOutside.map(p => p.value),
    });
  }
  return chips;
}

/** `list` without `drop`, ignoring case, or undefined when nothing is left: a filter with no values is no
 *  filter on a plain address. */
export function dropValues(list: readonly string[] | undefined, drop: readonly string[]): string[] | undefined {
  const gone = new Set(drop.map(v => v.toLowerCase()));
  const kept = (list ?? []).filter(v => !gone.has(v.toLowerCase()));
  return kept.length > 0 ? kept : undefined;
}

/** A value that no longer exists reads as its name with the mark after it. */
export function markedLabel(name: string, note: string): string {
  return `${name} (${note})`;
}

/** The dimension, if any, whose every value matches nothing, which an empty list says rather than the
 *  words for a list that is genuinely empty. A Scope filter is checked first. */
export type MatchesNothing = 'scope-outside' | 'scope-gone' | 'scope-gone-or-outside' | 'scope-unresolved' | 'source' | 'tags';

export function dimensionMatchingNothing(states: FilterStates, tagCount: number): MatchesNothing | null {
  if (states.scopeUnresolved) return 'scope-unresolved';
  const picked = states.scope.length + states.scopeHidden.outside + states.scopeHidden.outsideNarrowed;
  const matchNothing = (p: ScopePickState) => p.access === 'outside' || p.access === 'unresolved';
  if (picked > 0 && states.scopeHidden.outsideNarrowed === 0 && states.scope.every(matchNothing)) {
    const gone = states.scope.some(p => p.access === 'unresolved');
    const outside = states.scopeHidden.outside > 0 || states.scope.some(p => p.access === 'outside');
    return gone ? (outside ? 'scope-gone-or-outside' : 'scope-gone') : 'scope-outside';
  }
  if (states.source.length > 0 && states.source.every(s => !s.exists)) return 'source';
  if (tagCount > 0 && states.missingTags.length >= tagCount) return 'tags';
  return null;
}
