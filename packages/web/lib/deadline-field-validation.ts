import { DEFAULT_PROJECT_COLUMNS, projectedColumnNames } from '@rulebeat/core/kql';
import type { Rule, RuleKind } from '@rulebeat/core';
import { createTenantContext } from './azure-credential';

export const DEADLINE_BACKEND_ERROR = 'A Deadline column is only available on Resource Graph rules.';
export const DEADLINE_TYPE_ERROR = 'The Deadline column must be the name of a column the query returns.';

/** What the check needs of a rule: its query as the engine will run it. */
export type DeadlineCheckRule = Pick<Rule, 'queryBackend' | 'rawKql' | 'projectColumns'>;

/** Runs a query and returns a few of its rows, for a query whose columns cannot be read from its text. */
export type ProbeRows = (kql: string) => Promise<Record<string, unknown>[]>;

/** A blank or null Deadline column means "none"; anything else that is not a string is refused. */
export function normalizeDeadlineField(value: unknown): { ok: true; field: string | undefined } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, field: undefined };
  if (typeof value !== 'string') return { ok: false, error: DEADLINE_TYPE_ERROR };
  const field = value.trim();
  return { ok: true, field: field === '' ? undefined : field };
}

/** The columns a rule's saved query returns when they can be read without running it: the final
 *  `| project` of its KQL, or, for a rule with no KQL of its own, its output columns (or the default
 *  ones the builder projects). Null means the query has to be run to find out. */
export function knownProjectedColumns(rule: DeadlineCheckRule): string[] | null {
  if (rule.rawKql) return projectedColumnNames(rule.rawKql);
  return rule.projectColumns?.length ? rule.projectColumns : DEFAULT_PROJECT_COLUMNS;
}

/**
 * What a rule-save request does to the Deadline column. `requested` is the raw body value, `stored`
 * what the rule holds now (none, for a new rule), `kind` the kind the rule will have after the save.
 * Returns the value to store (undefined clears it) or the message to refuse the save with.
 *
 * A column is checked against the query when it is being set to something new, or when the rule is
 * an Advisory and so actually reads it. An unchanged column on a rule that is not an Advisory is
 * left alone: it is kept for when the kind is switched back, and editing that rule's query must not
 * be blocked by a setting the form does not show.
 */
export async function checkDeadlineFieldRequest(opts: {
  requested: unknown;
  stored: string | undefined;
  kind: RuleKind | undefined;
  rule: DeadlineCheckRule;
  probeRows?: ProbeRows;
}): Promise<{ ok: true; field: string | undefined } | { ok: false; error: string }> {
  const normalized = normalizeDeadlineField(opts.requested);
  if (!normalized.ok) return normalized;
  const { field } = normalized;
  if (field === undefined) return { ok: true, field };
  if (field === opts.stored && opts.kind !== 'advisory') return { ok: true, field };
  const error = await validateDeadlineField(field, opts.rule, opts.probeRows ?? probeViaTenant);
  return error ? { ok: false, error } : { ok: true, field };
}

async function probeViaTenant(kql: string): Promise<Record<string, unknown>[]> {
  const ctx = await createTenantContext();
  return ctx.queryARG<Record<string, unknown>>(kql);
}

/**
 * The save-time check for a Deadline column: null when it can be saved, otherwise the message to
 * return. The column has to be one the query projects, because the scan reads it from each result
 * row and a name the query never returns would leave every Advisory without a Deadline, silently.
 *
 * Only Resource Graph rules have a Deadline column. When the projection cannot be read from the
 * KQL (no trailing `| project`), the query is sampled, the same way the identity check does it,
 * and the save is refused only when that sample returned rows without the column. A sample that
 * returns no rows, or cannot run (no credential, Azure unreachable), tells nothing, so it allows
 * the save rather than blocking an edit on a transient failure.
 */
export async function validateDeadlineField(
  field: string,
  rule: DeadlineCheckRule,
  probeRows: ProbeRows,
): Promise<string | null> {
  if ((rule.queryBackend ?? 'resource-graph') !== 'resource-graph') return DEADLINE_BACKEND_ERROR;

  const known = knownProjectedColumns(rule);
  if (known) {
    return known.includes(field)
      ? null
      : `The Deadline column "${field}" is not a column this query returns. Project it in the query, or clear the Deadline column.`;
  }

  const kql = rule.rawKql as string;
  const limited = /\|\s*(take|limit|top)\s+\d+/i.test(kql) ? kql : `${kql.trim()}\n| take 5`;
  let rows: Record<string, unknown>[];
  try {
    rows = await probeRows(limited);
  } catch (err) {
    console.error('[RuleBeat] rule-save Deadline column probe could not run, allowing save:', err);
    return null;
  }
  if (rows.length === 0 || rows.some(row => field in row)) return null;
  return `The Deadline column "${field}" is not a column this query returns. Project it in the query, or clear the Deadline column.`;
}
