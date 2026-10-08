/**
 * Issue #177: the Deadline column is checked against what the saved query projects, so reading the
 * final `| project` of a KQL string has to name the columns the row will actually carry: an alias,
 * a bare column, a dotted path (which Resource Graph flattens), and nothing for an expression
 * with no alias.
 */
import { describe, expect, it } from 'vitest';
import { projectedColumnNames } from '../src/engine/kql.js';

describe('projectedColumnNames()', () => {
  it.each([
    ['resources | project id, name, type', ['id', 'name', 'type']],
    ['resources | where type == "x" | project id, retiresOn = tostring(properties.retireDate)', ['id', 'retiresOn']],
    ['resources | project id, properties.retireDate', ['id', 'properties_retireDate']],
    ['resources | project id, tostring(properties.x)', ['id']],
    ['resources | project id | where id != "" | project id, dueDate = todatetime(tags.due)', ['id', 'dueDate']],
  ])('reads %s', (kql, expected) => {
    expect(projectedColumnNames(kql)).toEqual(expected);
  });

  it('is null when the query has no trailing project to read', () => {
    expect(projectedColumnNames('resources | where type == "x"')).toBeNull();
    expect(projectedColumnNames('resources | extend due = tostring(properties.due)')).toBeNull();
  });
});
