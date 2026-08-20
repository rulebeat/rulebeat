/**
 * RB-RM-004 — a rule can look filled in (a field selected, an operator picked, values typed) and
 * still compile to no `| where` clause at all, silently matching every resource in scope. This
 * suite locks the specific compile-time gaps `hasCompilableFilter()` closes, since the guard it
 * replaced (`isRealCondition()`) only checked that a field string was non-empty — never that the
 * condition actually produced KQL.
 *
 * RB-RM-005 was the specific case of `managedBy`/`tenantId`: the container-field picker offered
 * them but `fieldToKqlExpr()`'s allowlist didn't, so a condition on either silently compiled to
 * null. Spec 031 closed it by widening the allowlist rather than removing the fields from the
 * picker, so both now compile — see the two "RB-RM-005" cases below, which assert that resolution
 * rather than the bug it replaced.
 */
import { describe, expect, it } from 'vitest';
import { hasCompilableFilter } from '../src/engine/kql.js';
import type { VisualFilterCondition, VisualQuery } from '../src/engine/types.js';

let seq = 0;
function id(): string {
  return `test-id-${++seq}`;
}

function queryWithConditions(...conditions: Omit<VisualFilterCondition, 'id'>[]): VisualQuery {
  return {
    stages: [{
      id: id(),
      type: 'filter',
      groups: [{ id: id(), conditions: conditions.map(c => ({ id: id(), ...c })) }],
    }],
  };
}

describe('hasCompilableFilter (RB-RM-004)', () => {
  it('is false for a query with no stages at all', () => {
    expect(hasCompilableFilter({ stages: [] })).toBe(false);
  });

  it('is false for a filter stage with no groups', () => {
    expect(hasCompilableFilter({ stages: [{ id: id(), type: 'filter', groups: [] }] })).toBe(false);
  });

  it('is false for a filter stage whose only group has no conditions', () => {
    expect(hasCompilableFilter({
      stages: [{ id: id(), type: 'filter', groups: [{ id: id(), conditions: [] }] }],
    })).toBe(false);
  });

  it('is true for a genuinely compilable condition', () => {
    const vq = queryWithConditions({ field: 'name', operator: 'equals', value: 'foo' });
    expect(hasCompilableFilter(vq)).toBe(true);
  });

  it('is false for hasAny with an empty values array — the exact shape that used to save a filterless rule', () => {
    const vq = queryWithConditions({ field: 'tags.env', operator: 'hasAny', values: [] });
    expect(hasCompilableFilter(vq)).toBe(false);
  });

  it('is false for in/notIn with an empty values array', () => {
    expect(hasCompilableFilter(queryWithConditions({ field: 'location', operator: 'in', values: [] }))).toBe(false);
    expect(hasCompilableFilter(queryWithConditions({ field: 'location', operator: 'notIn', values: [] }))).toBe(false);
  });

  it('is true for managedBy now that fieldToKqlExpr can write it back (RB-RM-005, closed by spec 031)', () => {
    const vq = queryWithConditions({ field: 'managedBy', operator: 'equals', value: 'foo' });
    expect(hasCompilableFilter(vq)).toBe(true);
  });

  it('is true for tenantId with an exists check, for the same reason (RB-RM-005)', () => {
    const vq = queryWithConditions({ field: 'tenantId', operator: 'exists' });
    expect(hasCompilableFilter(vq)).toBe(true);
  });

  it('is false for a field the generator genuinely has no case for', () => {
    const vq = queryWithConditions({ field: 'totallyUnsupportedField', operator: 'equals', value: 'foo' });
    expect(hasCompilableFilter(vq)).toBe(false);
  });

  it('is true for a raw passthrough condition carrying real KQL', () => {
    const vq = queryWithConditions({ field: '', operator: 'raw', rawExpr: "type =~ 'microsoft.compute/disks'" });
    expect(hasCompilableFilter(vq)).toBe(true);
  });

  it('is false for a raw passthrough condition whose rawExpr is blank', () => {
    const vq = queryWithConditions({ field: '', operator: 'raw', rawExpr: '   ' });
    expect(hasCompilableFilter(vq)).toBe(false);
  });

  it('is true when only one of several groups in a stage compiles', () => {
    const vq: VisualQuery = {
      stages: [{
        id: id(),
        type: 'filter',
        groups: [
          { id: id(), conditions: [{ id: id(), field: 'totallyUnsupportedField', operator: 'equals', value: 'x' }] },
          { id: id(), conditions: [{ id: id(), field: 'name', operator: 'equals', value: 'y' }] },
        ],
      }],
    };
    expect(hasCompilableFilter(vq)).toBe(true);
  });

  it('is true when only one of several filter stages compiles', () => {
    const vq: VisualQuery = {
      stages: [
        { id: id(), type: 'filter', groups: [{ id: id(), conditions: [{ id: id(), field: 'totallyUnsupportedField', operator: 'exists' }] }] },
        { id: id(), type: 'filter', groups: [{ id: id(), conditions: [{ id: id(), field: 'name', operator: 'exists' }] }] },
      ],
    };
    expect(hasCompilableFilter(vq)).toBe(true);
  });

  it('ignores non-filter stages entirely', () => {
    const vq: VisualQuery = {
      stages: [{ id: id(), type: 'sort', columns: [{ field: 'name', direction: 'asc' }] }],
    };
    expect(hasCompilableFilter(vq)).toBe(false);
  });
});
