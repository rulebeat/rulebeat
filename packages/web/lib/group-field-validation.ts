import {
  checkColumnFieldRequest, validateColumnField, normalizeColumnField, columnBackendError, columnTypeError,
  type ProjectedColumnRule, type ProbeRows, type ColumnRequestResult,
} from './projected-column-validation';
import type { RuleKind } from '@rulebeat/core';

export const GROUP_BACKEND_ERROR = columnBackendError('Group');
export const GROUP_TYPE_ERROR = columnTypeError('Group');

/** A blank or null Group column means "none"; anything else that is not a string is refused. */
export const normalizeGroupField = (value: unknown): ColumnRequestResult => normalizeColumnField('Group', value);

/** What a rule-save request does to the Group column; see `checkColumnFieldRequest()`. */
export function checkGroupFieldRequest(opts: {
  requested: unknown;
  stored: string | undefined;
  kind: RuleKind | undefined;
  rule: ProjectedColumnRule;
  probeRows?: ProbeRows;
}): Promise<ColumnRequestResult> {
  return checkColumnFieldRequest('Group', opts);
}

/** The save-time check for a Group column; see `validateColumnField()`. */
export const validateGroupField = (field: string, rule: ProjectedColumnRule, probeRows: ProbeRows) =>
  validateColumnField('Group', field, rule, probeRows);
