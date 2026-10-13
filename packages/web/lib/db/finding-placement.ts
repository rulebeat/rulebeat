// Sub-path import, not the package root, for the same reason as fingerprint-rekey.ts: the database
// layer's import graph stays free of the Azure SDK.
import { classifyArmPlacement } from '@rulebeat/core/finding';
import type { FindingPlacement } from '../placement';

/**
 * Corrects where each stored finding sits (#271).
 *
 * Until placement existed, a Microsoft Graph finding and a Log Analytics finding both carried the
 * first subscription the credential listed, so a view filtered to that subscription counted
 * directory findings under it. The upgrade gives every stored finding, and every Run History record
 * of one, the placement its own columns and its rule imply, and changes nothing else: no fingerprint,
 * no age, no event, no row, no suppression.
 *
 * - A finding of a `microsoft-graph` rule is `directory`, with an empty subscription and no resource
 *   group.
 * - An `activity` finding is a Logs finding. Placing it at its workspace needs Resource Graph, which
 *   a migration cannot call, so here it becomes `unplaceable` with an empty subscription and
 *   `lib/workspace-placement.ts` moves it to `workspace` at startup once the workspace resolves.
 *   One already `workspace` or `unplaceable` is left as it is.
 * - Every other finding has the placement its subscription, resource group and id imply
 *   (`classifyArmPlacement()`, the function a fresh scan classifies with).
 *
 * Idempotent, so both backends run it on every start and a returning earlier release's rows are
 * corrected too. Pure: rows in, SQL statements out, so SQLite (migrate.ts) and Postgres
 * (pg/bootstrap.ts) execute one plan rather than two implementations of it.
 */

/**
 * The placement of a finding that does not state one: a stored scan blob, or a finding built outside
 * the scan path. A Logs (`activity`) finding sits at its workspace when it has a subscription and is
 * otherwise unplaceable; every other finding sits where `classifyArmPlacement()` says. It cannot
 * know a Graph rule's finding is a directory one, which only the rule says, so the callers that can
 * ask the rule do.
 */
export function derivePlacement(f: {
  kind?: string; subscriptionId?: string | null; resourceGroup?: string | null; resourceId?: string | null;
}): { placement: FindingPlacement; managementGroupId?: string } {
  if (f.kind === 'activity') return { placement: f.subscriptionId ? 'workspace' : 'unplaceable' };
  return classifyArmPlacement(f);
}

export type PlacementTable = 'findings' | 'scan_findings';
export const PLACEMENT_TABLES: readonly PlacementTable[] = ['findings', 'scan_findings'];

/** One statement with `?` placeholders; the Postgres caller binds them positionally. */
export interface PlacementStatement { sql: string; params: string[] }

/** The rules whose findings sit in the directory. A subquery, so the plan needs no list of ids. */
const GRAPH_RULE_IDS = `SELECT id FROM rules WHERE query_backend = 'microsoft-graph'`;

/** The rows of the stored placement columns the classification reads. */
export interface PlacementRow {
  /** Present only on a `scan_findings` row, whose key is the scan and the fingerprint. */
  scan_id?: string;
  fingerprint: string;
  resource_id: string | null;
  resource_group: string | null;
  subscription_id: string;
  placement: string;
  management_group_id: string | null;
}

/**
 * The rows the classification may have to change: neither a Graph nor an Activity finding, and not
 * one of the three plain cases that are already right (a subscription and a resource group stored as
 * a `resource`, a subscription alone stored as a `subscription`, no subscription and no management
 * group id stored as `unplaceable`). A record stored as `directory` is never read: only a Graph rule's
 * own statement below puts a row there, and a record of a rule that has since been deleted is still
 * a directory record, which no classification of its columns could tell. Every start reads this, so it leaves out what steady state is made
 * of; `classifyArmPlacement()` still decides every row it does return. A superset is harmless, since
 * the plan only emits a change for a row whose stored placement differs from what it classifies to.
 * Plain SQL valid on both backends.
 */
export function placementRead(table: PlacementTable): string {
  const key = table === 'scan_findings' ? 'scan_id, fingerprint' : 'fingerprint';
  return `SELECT ${key}, resource_id, resource_group, subscription_id, placement, management_group_id FROM ${table}
    WHERE kind <> 'activity' AND placement <> 'directory' AND rule_id NOT IN (${GRAPH_RULE_IDS})
      AND NOT (
        (placement = 'resource' AND subscription_id <> '' AND COALESCE(resource_group, '') <> '')
        OR (placement = 'subscription' AND subscription_id <> '' AND COALESCE(resource_group, '') = '')
        OR (placement = 'unplaceable' AND subscription_id = '' AND management_group_id IS NULL
            AND LOWER(COALESCE(resource_id, '')) NOT LIKE '/providers/microsoft.management/managementgroups/%')
      )`;
}

const CHUNK = 400;

/** The statements that correct `table`, given the rows `placementRead(table)` returned. */
export function planFindingPlacement(table: PlacementTable, rows: readonly PlacementRow[]): PlacementStatement[] {
  const statements: PlacementStatement[] = [
    {
      sql: `UPDATE ${table} SET placement = 'directory', subscription_id = '', resource_group = NULL, management_group_id = NULL
        WHERE rule_id IN (${GRAPH_RULE_IDS})
          AND (placement <> 'directory' OR subscription_id <> '' OR resource_group IS NOT NULL OR management_group_id IS NOT NULL)`,
      params: [],
    },
    {
      sql: `UPDATE ${table} SET placement = 'unplaceable', subscription_id = '', resource_group = NULL, management_group_id = NULL
        WHERE kind = 'activity' AND placement NOT IN ('workspace', 'unplaceable')`,
      params: [],
    },
  ];

  // Rows that classify to the same place (and, for a record, sit in the same scan) share a statement.
  const groups = new Map<string, { scanId?: string; placement: string; managementGroupId?: string; fingerprints: string[] }>();
  for (const row of rows) {
    // The read leaves these out; a caller that hands one in does not move it either.
    if (row.placement === 'directory') continue;
    const next = classifyArmPlacement({
      subscriptionId: row.subscription_id,
      resourceGroup: row.resource_group,
      resourceId: row.resource_id,
    });
    if (row.placement === next.placement && (row.management_group_id ?? undefined) === next.managementGroupId) continue;
    const key = JSON.stringify([row.scan_id ?? null, next.placement, next.managementGroupId ?? null]);
    const group = groups.get(key);
    if (group) group.fingerprints.push(row.fingerprint);
    else groups.set(key, { scanId: row.scan_id, placement: next.placement, managementGroupId: next.managementGroupId, fingerprints: [row.fingerprint] });
  }

  for (const group of groups.values()) {
    for (let i = 0; i < group.fingerprints.length; i += CHUNK) {
      const fingerprints = group.fingerprints.slice(i, i + CHUNK);
      const marks = fingerprints.map(() => '?').join(', ');
      const managementGroup = group.managementGroupId === undefined ? 'management_group_id = NULL' : 'management_group_id = ?';
      statements.push({
        sql: `UPDATE ${table} SET placement = ?, ${managementGroup} WHERE ${group.scanId === undefined ? '' : 'scan_id = ? AND '}fingerprint IN (${marks})`,
        params: [
          group.placement,
          ...(group.managementGroupId === undefined ? [] : [group.managementGroupId]),
          ...(group.scanId === undefined ? [] : [group.scanId]),
          ...fingerprints,
        ],
      });
    }
  }
  return statements;
}
