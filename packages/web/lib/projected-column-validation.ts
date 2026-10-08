import { DEFAULT_PROJECT_COLUMNS, projectedColumnNames } from '@rulebeat/core/kql';
import type { Rule, RuleKind } from '@rulebeat/core';
import { createTenantContext } from './azure-credential';

/**
 * The save-time check shared by every rule setting that names a column the query returns: the
 * Deadline column and the Group column. `label` is how the setting is named in a message
 * ("Deadline", "Group"). The scan reads the column from each result row, so a name the query never
 * returns would leave every Advisory without that value, silently.
 */
export type ColumnLabel = 'Deadline' | 'Group';

/** What the check needs of a rule: its query as the engine will run it. */
export type ProjectedColumnRule = Pick<Rule, 'queryBackend' | 'rawKql' | 'projectColumns'>;

/** Runs a query and returns a few of its rows, for a query whose columns cannot be read from its text. */
export type ProbeRows = (kql: string) => Promise<Record<string, unknown>[]>;

export type ColumnRequestResult = { ok: true; field: string | undefined } | { ok: false; error: string };

export const columnBackendError = (label: ColumnLabel) => `A ${label} column is only available on Resource Graph rules.`;
export const columnTypeError = (label: ColumnLabel) => `The ${label} column must be the name of a column the query returns.`;
const columnMissingError = (label: ColumnLabel, field: string) =>
  `The ${label} column "${field}" is not a column this query returns. Project it in the query, or clear the ${label} column.`;

/** A blank or null column means "none"; anything else that is not a string is refused. */
export function normalizeColumnField(label: ColumnLabel, value: unknown): ColumnRequestResult {
  if (value === undefined || value === null) return { ok: true, field: undefined };
  if (typeof value !== 'string') return { ok: false, error: columnTypeError(label) };
  const field = value.trim();
  return { ok: true, field: field === '' ? undefined : field };
}

/** The columns a rule's saved query returns when they can be read without running it: the final
 *  `| project` of its KQL, or, for a rule with no KQL of its own, its output columns (or the default
 *  ones the builder projects). Null means the query has to be run to find out. */
export function knownProjectedColumns(rule: ProjectedColumnRule): string[] | null {
  if (rule.rawKql) return projectedColumnNames(rule.rawKql);
  return rule.projectColumns?.length ? rule.projectColumns : DEFAULT_PROJECT_COLUMNS;
}

/**
 * What a rule-save request does to a column setting. `requested` is the raw body value, `stored`
 * what the rule holds now (none, for a new rule), `kind` the kind the rule will have after the save.
 * Returns the value to store (undefined clears it) or the message to refuse the save with.
 *
 * A column is checked against the query when it is being set to something new, or when the rule is
 * an Advisory and so actually reads it. An unchanged column on a rule that is not an Advisory is
 * left alone: it is kept for when the kind is switched back, and editing that rule's query must not
 * be blocked by a setting the form does not show.
 */
export async function checkColumnFieldRequest(label: ColumnLabel, opts: {
  requested: unknown;
  stored: string | undefined;
  kind: RuleKind | undefined;
  rule: ProjectedColumnRule;
  probeRows?: ProbeRows;
}): Promise<ColumnRequestResult> {
  const normalized = normalizeColumnField(label, opts.requested);
  if (!normalized.ok) return normalized;
  const { field } = normalized;
  if (field === undefined) return { ok: true, field };
  if (field === opts.stored && opts.kind !== 'advisory') return { ok: true, field };
  const error = await validateColumnField(label, field, opts.rule, opts.probeRows ?? probeViaTenant);
  return error ? { ok: false, error } : { ok: true, field };
}

async function probeViaTenant(kql: string): Promise<Record<string, unknown>[]> {
  const ctx = await createTenantContext();
  return ctx.queryARG<Record<string, unknown>>(kql);
}

/**
 * The save-time check for a column setting: null when it can be saved, otherwise the message to
 * return. The column has to be one the query projects.
 *
 * Only Resource Graph rules have these columns. When the projection cannot be read from the
 * KQL (no trailing `| project`), the query is sampled, the same way the identity check does it,
 * and the save is refused only when that sample returned rows without the column. A sample that
 * returns no rows, or cannot run (no credential, Azure unreachable), tells nothing, so it allows
 * the save rather than blocking an edit on a transient failure.
 */
export async function validateColumnField(
  label: ColumnLabel,
  field: string,
  rule: ProjectedColumnRule,
  probeRows: ProbeRows,
): Promise<string | null> {
  if ((rule.queryBackend ?? 'resource-graph') !== 'resource-graph') return columnBackendError(label);

  const known = knownProjectedColumns(rule);
  if (known) return known.includes(field) ? null : columnMissingError(label, field);

  const kql = rule.rawKql as string;
  const limited = /\|\s*(take|limit|top)\s+\d+/i.test(kql) ? kql : `${kql.trim()}\n| take 5`;
  let rows: Record<string, unknown>[];
  try {
    rows = await probeRows(limited);
  } catch (err) {
    console.error(`[RuleBeat] rule-save ${label} column probe could not run, allowing save:`, err);
    return null;
  }
  if (rows.length === 0 || rows.some(row => field in row)) return null;
  return columnMissingError(label, field);
}
