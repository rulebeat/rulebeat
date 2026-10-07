import { createHash } from 'node:crypto';
import { canonicalDefinition, sameValue } from './rule-versions';
import { nonEmptyString, packEntryDefinition, type RuleDefinition } from './shipped-catalogue';

/**
 * The versioning step of the pack sync (`scripts/sync-pack.ts`, ticket #165, ADR 0004). It is pure:
 * the previous pack file, the freshly fetched rules and the pinned commit go in, the new pack file's
 * rules come out, with no network and no file access, so it is tested against two fixture snapshots.
 *
 * Lives in `lib/` rather than `scripts/` because the loader and the tests read the same entries, and
 * product code never imports from `scripts/`.
 *
 * A rule whose definition did not change keeps its version, note and upstream commit, so a sync that
 * touches 3 of 143 rules shows 3 new versions rather than 143. A changed rule gets the pinned
 * commit's upstream date and a generated note naming the changed fields; RuleBeat never invents a
 * version for a third-party rule, and the date the sync ran is never one.
 */

/** One entry of a pack file: the definition fields plus `enabled`, `type`, `pack` and, once a sync has
 *  versioned it, the rule's own `version`, `releaseNote` and `upstreamRef`. */
export type PackFileRule = Record<string, unknown> & { id: string };

export interface PackVersionDefaults {
  version: string;
  releaseNote: string;
  upstreamRef?: string;
}

export interface VersionPackInput {
  /** The rules of the pack file as committed before this sync; empty for a pack's first sync. */
  previous: PackFileRule[];
  /** The rules the sync just fetched, with no version of their own. */
  next: PackFileRule[];
  /** The pinned commit's upstream committer date: the version of every rule that changed. */
  pinnedCommitDate: string;
  pinnedCommit: string;
  /**
   * What a previous entry with no version of its own was shipped under: the pack's old manifest
   * version, note and commit. Needed once, for a pack file written before rules carried their own
   * version, so its unchanged rules keep that version instead of all becoming new.
   */
  previousPackDefaults?: PackVersionDefaults;
}

export interface VersionPackSummary {
  unchanged: string[];
  changed: string[];
  added: string[];
  dropped: string[];
}

/** What a changed field is called in a release note, in the order a definition lists them. */
const FIELD_LABELS: Array<[keyof RuleDefinition, string]> = [
  ['name', 'name'],
  ['description', 'description'],
  ['category', 'category'],
  ['severity', 'severity'],
  ['queryBackend', 'query backend'],
  ['kind', 'kind'],
  ['resourceTypes', 'resource types'],
  ['scope', 'scope'],
  ['conditions', 'conditions'],
  ['conditionGroups', 'condition groups'],
  ['visualQuery', 'visual query'],
  ['projectColumns', 'project columns'],
  ['rawKql', 'query'],
  ['graphQuery', 'Graph query'],
  ['logsQuery', 'Logs query'],
];

/** A hash over the canonical definition: equal for two definitions with the same content, whatever
 *  order their keys are in and whatever else an entry carries. */
export function definitionHash(definition: RuleDefinition): string {
  return createHash('sha256').update(canonicalDefinition(definition)).digest('hex');
}

function changedFieldLabels(before: RuleDefinition, after: RuleDefinition): string[] {
  return FIELD_LABELS.filter(([field]) => !sameValue(before[field], after[field])).map(([, label]) => label);
}

function ownVersionOf(entry: PackFileRule, defaults: PackVersionDefaults | undefined): PackVersionDefaults {
  const version = nonEmptyString(entry.version);
  if (version) {
    return {
      version,
      releaseNote: nonEmptyString(entry.releaseNote) ?? `Version ${version}.`,
      upstreamRef: nonEmptyString(entry.upstreamRef),
    };
  }
  if (!defaults) {
    throw new Error(`Rule ${entry.id} in the previous pack file has no version, and no previous pack version was given to take its place.`);
  }
  return defaults;
}

export function versionPackRules(input: VersionPackInput): { rules: PackFileRule[]; summary: VersionPackSummary } {
  const previousById = new Map(input.previous.map(r => [r.id, r]));
  const nextIds = new Set(input.next.map(r => r.id));
  const summary: VersionPackSummary = { unchanged: [], changed: [], added: [], dropped: [] };

  const rules = input.next.map((fresh): PackFileRule => {
    // A fetched entry carries no version; whatever it was given is replaced below.
    const { version: _v, releaseNote: _n, upstreamRef: _u, ...entry } = fresh;
    const stamp = (v: PackVersionDefaults): PackFileRule => {
      const stamped: PackFileRule = { ...entry, version: v.version, releaseNote: v.releaseNote };
      if (v.upstreamRef) stamped.upstreamRef = v.upstreamRef;
      return stamped;
    };
    const atPinnedCommit = (releaseNote: string) =>
      stamp({ version: input.pinnedCommitDate, releaseNote, upstreamRef: input.pinnedCommit });

    const before = previousById.get(fresh.id);
    if (!before) {
      summary.added.push(fresh.id);
      return atPinnedCommit('Added to the pack.');
    }

    const beforeDefinition = packEntryDefinition(before);
    const afterDefinition = packEntryDefinition(fresh);
    if (definitionHash(beforeDefinition) === definitionHash(afterDefinition)) {
      summary.unchanged.push(fresh.id);
      return stamp(ownVersionOf(before, input.previousPackDefaults));
    }
    summary.changed.push(fresh.id);
    return atPinnedCommit(`Changed: ${changedFieldLabels(beforeDefinition, afterDefinition).join(', ')}.`);
  });

  summary.dropped = input.previous.filter(r => !nextIds.has(r.id)).map(r => r.id);
  return { rules, summary };
}
