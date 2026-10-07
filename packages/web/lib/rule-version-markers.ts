import { BEFORE_VERSIONING } from './before-versioning';
import type { Rule } from './types';

/**
 * What the Library list and the rule view say about versions (ticket #165, ADR 0004). Everything
 * here is pure and client-safe: the database read lives in `db/recorded-versions.ts`, and the
 * components only call these.
 *
 * Nothing else announces a version. A rule has a "New version" marker when this install has recorded
 * a version newer than the one the rule runs, and a "Retired" marker when no pack ships it any more.
 */

/** A row of `rule_versions` without its definition. `sortKey` orders a rule's versions oldest to
 *  newest by plain text comparison (`versionSortKey()` in `rule-versions.ts` makes it). */
export interface RecordedVersion {
  ruleId: string;
  version: string;
  sortKey: string;
}

/** The two things a Library filter can pick. */
export type VersionMarker = 'new-version' | 'retired';

/** An upstream-commit-date version (an ISO timestamp), as opposed to semver or Before versioning. */
export function isCommitDateVersion(version: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(version);
}

/** The YYYY-MM-DD (UTC) part of an ISO date. */
export function formatVersionDate(date: string): string {
  const time = Date.parse(date);
  return Number.isNaN(time) ? date.slice(0, 10) : new Date(time).toISOString().slice(0, 10);
}

/** How an admin reads a version: semver as it is, an upstream commit date as its date. */
export function versionLabel(version: string): string {
  if (version === BEFORE_VERSIONING) return 'Before versioning';
  return isCommitDateVersion(version) ? formatVersionDate(version) : version;
}

/** The sentence for a rule converted in place from a built-in. "Before versioning" is not a version
 *  a rule can be "at", so a rule that ran its stored definition gets the plain sentence. */
export function convertedOriginText(version: string | null): string {
  return version && version !== BEFORE_VERSIONING
    ? `Converted from the built-in rule at ${versionLabel(version)}.`
    : 'Converted from the built-in rule.';
}

/** The same sentence for every pack. */
export function retiredMessage(packLabel: string): string {
  return `Retired. ${packLabel} no longer ships this rule.`;
}

/** Plain code-unit comparison, which is what the stored keys are built for. */
function newest(versions: RecordedVersion[]): RecordedVersion {
  return versions.reduce((best, v) => (v.sortKey > best.sortKey ? v : best));
}

/**
 * For each rule that has a recorded version newer than the one it runs, the newest such version.
 * A rule absent from the result has nothing newer: a custom rule (no version), a rule on its newest
 * version, or one whose running version was never recorded, so there is nothing to compare against.
 */
export function newerVersionsByRule(
  rules: Pick<Rule, 'id' | 'version'>[],
  recorded: RecordedVersion[],
): Record<string, string> {
  const byRule = new Map<string, RecordedVersion[]>();
  for (const v of recorded) {
    const list = byRule.get(v.ruleId);
    if (list) list.push(v); else byRule.set(v.ruleId, [v]);
  }
  const result: Record<string, string> = {};
  for (const rule of rules) {
    if (!rule.version) continue;
    const all = byRule.get(rule.id);
    const running = all?.find(v => v.version === rule.version);
    if (!all || !running) continue;
    const latest = newest(all);
    if (latest.sortKey > running.sortKey) result[rule.id] = latest.version;
  }
  return result;
}

/** An empty selection keeps every rule; otherwise a rule stays if it carries any selected marker. */
export function matchesVersionFilter(
  rule: Pick<Rule, 'id' | 'retiredAt'>,
  newerVersions: Record<string, string>,
  selected: ReadonlySet<string>,
): boolean {
  // A set of plain strings, since that is what the toolbar's checklist holds; the values are the
  // two `VersionMarker`s.
  const wants = (marker: VersionMarker) => selected.has(marker);
  if (selected.size === 0) return true;
  if (wants('new-version') && newerVersions[rule.id] !== undefined) return true;
  if (wants('retired') && !!rule.retiredAt) return true;
  return false;
}

export type OriginNote =
  /** A copy made from another rule. `originName` is null when that rule has since been deleted. */
  | { kind: 'duplicate'; originRuleId: string; originName: string | null; version: string | null; hasNewerVersion: boolean }
  /** An Identity built-in whose query was tuned before built-ins became read-only, kept in place as a
   *  custom rule. It is its own origin, so there is no other rule that could have a newer version. */
  | { kind: 'converted'; version: string | null; hasNewerVersion: false };

/**
 * Where a custom rule came from, or null when nothing was recorded: a rule written from scratch, or
 * a duplicate made before origins were recorded. An origin is never guessed.
 */
export function describeOrigin(
  rule: Pick<Rule, 'id' | 'type' | 'originRuleId' | 'originVersion'>,
  rules: Pick<Rule, 'id' | 'name'>[],
  recorded: RecordedVersion[],
): OriginNote | null {
  if (rule.type !== 'custom' || !rule.originRuleId) return null;
  const version = rule.originVersion ?? null;
  if (rule.originRuleId === rule.id) return { kind: 'converted', version, hasNewerVersion: false };

  const ofOrigin = recorded.filter(v => v.ruleId === rule.originRuleId);
  const copied = version === null ? undefined : ofOrigin.find(v => v.version === version);
  return {
    kind: 'duplicate',
    originRuleId: rule.originRuleId,
    originName: rules.find(r => r.id === rule.originRuleId)?.name ?? null,
    version,
    hasNewerVersion: copied !== undefined && ofOrigin.some(v => v.sortKey > copied.sortKey),
  };
}
