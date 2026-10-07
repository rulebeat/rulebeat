import { many } from './exec';
import { db } from './client';
import { ruleVersions } from './tables';
import type { RecordedVersion } from '../rule-version-markers';

/**
 * Every version this install has recorded for every shipped rule, as just enough to order and name
 * them: no definition, no release note. One query, however many rules there are, so the Library can
 * mark every rule that has a newer version without reading a definition or asking per rule.
 *
 * The comparison itself happens on the caller's side, on `sortKey` as plain text
 * (`newerVersionsByRule()`), so it cannot disagree with the order a Postgres collation would give.
 */
export async function loadRecordedVersions(): Promise<RecordedVersion[]> {
  return many(db.select({
    ruleId: ruleVersions.ruleId,
    version: ruleVersions.version,
    sortKey: ruleVersions.sortKey,
  }).from(ruleVersions));
}
