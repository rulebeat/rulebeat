import type { Rule } from './types';

/**
 * What the Library list and the rule view say about versions (ticket #165, ADR 0004, ADR 0009).
 * Everything here is pure and client-safe: the database read lives in `db/recorded-versions.ts`, and
 * the components only call these.
 *
 * The Library shows the version a rule runs in its own column, with a "New" chip when this install
 * has recorded a newer one, and a "Retired" marker when no pack ships the rule any more.
 */

/** A row of `rule_versions` without its definition. `sortKey` orders a rule's versions oldest to
 *  newest by plain text comparison (`versionSortKey()` in `rule-versions.ts` makes it). */
export interface RecordedVersion {
  ruleId: string;
  version: string;
  sortKey: string;
}

/** An upstream-commit-date version (an ISO timestamp), as opposed to semver. */
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
  return isCommitDateVersion(version) ? formatVersionDate(version) : version;
}

/** The sentence for a rule converted in place from a built-in. */
export function convertedOriginText(version: string | null): string {
  return version
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
