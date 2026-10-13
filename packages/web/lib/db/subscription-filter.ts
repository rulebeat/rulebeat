import { eq, inArray, or, type SQL } from 'drizzle-orm';
import { findings as findingsTable } from './tables';
import { DIRECTORY_SUBSCRIPTION } from '../placement';

/**
 * The condition a subscription filter puts on the `findings` table. A value is a subscription id, or
 * the reserved Directory value (lib/placement.ts), which stands for the findings that sit in the
 * directory and are stored with an empty subscription. Only a stored subscription id can match an id,
 * so a Directory finding is never counted under one.
 */
export function subscriptionFilterSql(values: readonly string[]): SQL {
  const ids = values.filter(v => v !== DIRECTORY_SUBSCRIPTION);
  const conditions: SQL[] = [];
  if (ids.length > 0) conditions.push(inArray(findingsTable.subscriptionId, ids));
  if (ids.length < values.length) conditions.push(eq(findingsTable.placement, 'directory'));
  return conditions.length === 1 ? conditions[0]! : or(...conditions)!;
}
