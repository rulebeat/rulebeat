// Sub-path import, not the package root, for the same reason as migrate.ts: the database layer's
// import graph stays free of the Azure SDK.
import { computeFingerprint, computeLegacyFingerprint } from '@rulebeat/core/finding';

/**
 * Moves stored fingerprints onto the case-insensitive formula `computeFingerprint()` now uses.
 *
 * Until it lowercased the resource id, a finding's fingerprint was `sha256(ruleId::resourceId)` over
 * the id exactly as Resource Graph returned it, and Resource Graph does not always return the same
 * casing for the same resource. A casing change (`RG-APP` one scan, `rg-app` the next) resolved the
 * finding and opened a new one. After the formula change, every stored fingerprint of an id with an
 * uppercase letter in it is one the next scan will never compute again, so without this rewrite an
 * upgrade would strand every such finding's age and history and, worst, silently stop every
 * suppression on it from suppressing. Same failure as a rule rename, see migrate.ts's
 * remapFingerprints().
 *
 * Matching is exact, never inferred: a finding moves only when its stored fingerprint really is the
 * legacy one for its own rule and resource id. A suppression has no rule id, so it follows its
 * finding, or failing that is matched against every known rule id the same exact way.
 *
 * Findings the bug already split in two (same rule, same resource, different casing) now collapse
 * onto one fingerprint and are merged into one history: the most recent sighting supplies the row
 * (status, last seen, evidence, the id's casing), the earliest first-seen is kept so the finding's
 * age is true, times-seen is summed, and every event of both moves onto the merged finding.
 *
 * Pure: rows in, SQL statements out, so SQLite (migrate.ts) and Postgres (pg/bootstrap.ts) execute
 * one plan rather than two implementations of it. Both run it in a transaction with the marker
 * write, so it happens once, completely or not at all.
 */

export const FINGERPRINT_CASE_MARKER = 'fingerprint-case-v1';

/** The reads the plan needs. Plain SQL valid on both backends. */
export const REKEY_READS = {
  findings: `SELECT fingerprint, rule_id, kind, resource_id, status, first_seen_at, last_seen_at, times_seen FROM findings`,
  suppressions: `SELECT id, fingerprint, resource_id FROM suppressions`,
  rules: `SELECT id FROM rules`,
  scheduleRuns: `SELECT id, new_finding_fingerprints FROM schedule_runs WHERE new_finding_fingerprints IS NOT NULL`,
} as const;

export interface RekeyFindingRow {
  fingerprint: string;
  rule_id: string;
  kind: string | null;
  resource_id: string | null;
  status: string;
  first_seen_at: string;
  last_seen_at: string;
  times_seen: number;
}

export interface RekeySuppressionRow { id: string; fingerprint: string; resource_id: string | null }
export interface RekeyScheduleRunRow { id: string; new_finding_fingerprints: string | null }

export interface RekeyInput {
  findings: RekeyFindingRow[];
  suppressions: RekeySuppressionRow[];
  ruleIds: string[];
  scheduleRuns: RekeyScheduleRunRow[];
}

/** One statement with `?` placeholders; the Postgres caller binds them positionally. */
export interface RekeyStatement { sql: string; params: (string | number)[] }

/** The most recent sighting first; ties go to the one still active, then a stable order. */
function bySurvivorPreference(a: RekeyFindingRow, b: RekeyFindingRow): number {
  if (a.last_seen_at !== b.last_seen_at) return a.last_seen_at > b.last_seen_at ? -1 : 1;
  if (a.status !== b.status) return a.status === 'active' ? -1 : b.status === 'active' ? 1 : 0;
  return a.fingerprint < b.fingerprint ? -1 : 1;
}

export function planFingerprintRekey(input: RekeyInput): RekeyStatement[] {
  const statements: RekeyStatement[] = [];
  const occupied = new Set(input.findings.map(f => f.fingerprint));

  const groups = new Map<string, RekeyFindingRow[]>();
  for (const f of input.findings) {
    if ((f.kind ?? 'state') !== 'state' || !f.resource_id) continue;
    if (computeLegacyFingerprint(f.rule_id, f.resource_id) !== f.fingerprint) continue;
    const next = computeFingerprint(f.rule_id, f.resource_id);
    const group = groups.get(next);
    if (group) group.push(f); else groups.set(next, [f]);
  }

  // Every finding fingerprint that changes, including merged-away ones, so their events follow.
  const remap = new Map<string, string>();
  const ruleByFingerprint = new Map<string, string>();

  for (const [next, group] of groups) {
    // Something this plan does not own already sits at the target. Leave the whole group alone
    // rather than guess which row is the real one.
    if (occupied.has(next) && !group.some(f => f.fingerprint === next)) continue;

    for (const f of group) {
      ruleByFingerprint.set(f.fingerprint, f.rule_id);
      if (f.fingerprint !== next) remap.set(f.fingerprint, next);
    }

    const [survivor, ...merged] = [...group].sort(bySurvivorPreference);
    if (merged.length > 0) {
      const firstSeenAt = group.reduce((min, f) => (f.first_seen_at < min ? f.first_seen_at : min), survivor!.first_seen_at);
      const timesSeen = group.reduce((sum, f) => sum + Number(f.times_seen), 0);
      statements.push({
        sql: `UPDATE findings SET first_seen_at = ?, times_seen = ? WHERE fingerprint = ?`,
        params: [firstSeenAt, timesSeen, survivor!.fingerprint],
      });
      for (const f of merged) {
        statements.push({ sql: `DELETE FROM findings WHERE fingerprint = ?`, params: [f.fingerprint] });
      }
    }
    if (survivor!.fingerprint !== next) {
      statements.push({ sql: `UPDATE findings SET fingerprint = ? WHERE fingerprint = ?`, params: [next, survivor!.fingerprint] });
    }
  }

  for (const [from, to] of remap) {
    statements.push({ sql: `UPDATE finding_events SET fingerprint = ? WHERE fingerprint = ?`, params: [to, from] });
  }

  for (const s of input.suppressions) {
    if (!s.resource_id) continue;
    let to = remap.get(s.fingerprint);
    if (!to && !ruleByFingerprint.has(s.fingerprint)) {
      // No finding row to follow (it may have been removed since). Recognise the rule exactly.
      const ruleId = input.ruleIds.find(r => computeLegacyFingerprint(r, s.resource_id!) === s.fingerprint);
      if (ruleId) to = computeFingerprint(ruleId, s.resource_id);
    }
    if (to && to !== s.fingerprint) {
      statements.push({ sql: `UPDATE suppressions SET fingerprint = ? WHERE id = ?`, params: [to, s.id] });
    }
  }

  // A run's new-finding list is what its not-yet-sent notification looks findings up by.
  for (const run of input.scheduleRuns) {
    let list: unknown;
    try { list = JSON.parse(run.new_finding_fingerprints ?? 'null'); } catch { continue; }
    if (!Array.isArray(list)) continue;
    const rewritten = [...new Set(list.map(fp => (typeof fp === 'string' ? remap.get(fp) ?? fp : fp)))];
    if (JSON.stringify(rewritten) !== JSON.stringify(list)) {
      statements.push({ sql: `UPDATE schedule_runs SET new_finding_fingerprints = ? WHERE id = ?`, params: [JSON.stringify(rewritten), run.id] });
    }
  }

  return statements;
}
