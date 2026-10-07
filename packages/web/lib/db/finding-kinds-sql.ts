import { inArray } from 'drizzle-orm';
import { findings as findingsTable } from './tables';
import { FINDING_TOTAL_KINDS } from '../finding-kinds';
import type { RuleKind } from '../types';

/** SQL form of `countsInFindingTotals` (lib/finding-kinds.ts), for drizzle `where` clauses
 *  against the findings table. Server-only: imports the dialect-resolved table from
 *  lib/db/tables.ts, so this module must never be imported by client ('use client') code. */
export const countsInFindingTotalsSql = inArray(findingsTable.kind, FINDING_TOTAL_KINDS as RuleKind[]);
