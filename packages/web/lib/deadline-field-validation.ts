import {
  checkColumnFieldRequest, validateColumnField, normalizeColumnField, knownProjectedColumns,
  columnBackendError, columnTypeError,
  type ProjectedColumnRule, type ProbeRows, type ColumnRequestResult,
} from './projected-column-validation';
import type { RuleKind } from '@rulebeat/core';

export { knownProjectedColumns };
export type { ProbeRows };

export const DEADLINE_BACKEND_ERROR = columnBackendError('Deadline');
export const DEADLINE_TYPE_ERROR = columnTypeError('Deadline');

/** What the check needs of a rule: its query as the engine will run it. */
export type DeadlineCheckRule = ProjectedColumnRule;

/** A blank or null Deadline column means "none"; anything else that is not a string is refused. */
export const normalizeDeadlineField = (value: unknown): ColumnRequestResult => normalizeColumnField('Deadline', value);

/** What a rule-save request does to the Deadline column; see `checkColumnFieldRequest()`. */
export function checkDeadlineFieldRequest(opts: {
  requested: unknown;
  stored: string | undefined;
  kind: RuleKind | undefined;
  rule: DeadlineCheckRule;
  probeRows?: ProbeRows;
}): Promise<ColumnRequestResult> {
  return checkColumnFieldRequest('Deadline', opts);
}

/** The save-time check for a Deadline column; see `validateColumnField()`. */
export const validateDeadlineField = (field: string, rule: DeadlineCheckRule, probeRows: ProbeRows) =>
  validateColumnField('Deadline', field, rule, probeRows);
