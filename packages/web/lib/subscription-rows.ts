/**
 * One row of the Subscription scorecard and the order the rows are listed in. Pure and client-safe, so the
 * server builds the rows (lib/subscription-scorecard.ts) and the widget sorts and cuts what it was sent
 * with the same rule.
 */
import { DIRECTORY_LABEL } from './placement';

export interface SubscriptionRow {
  /** The subscription id as shown (the tree's casing when it knows the subscription), or the reserved Directory value. */
  subscriptionId: string;
  /** The management group tree's name for the subscription, else null. */
  name: string | null;
  /** The Directory row, graded by Microsoft Graph rules. */
  directory: boolean;
  /** Counted rules with no open finding in the row whose most recent run succeeded. */
  passingRules: number;
  /** Counted rules: enabled Problem rules whose scope overlaps the row. */
  totalRules: number;
  /** Counted rules with no open finding whose last run was not a proven success. */
  unknownRules: number;
  /** Null when no rule is counted. */
  pct: number | null;
  /** Findings placed in the row, whichever rule they belong to. */
  activeFindings: number;
  /** The row is counted over the resource groups the viewer holds, not the whole subscription. */
  yourGroupsOnly: boolean;
}

/** What names a row on screen: its name, else its id, and "Directory" for the Directory. */
export function rowLabel(row: Pick<SubscriptionRow, 'directory' | 'name' | 'subscriptionId'>, fallbackName?: string): string {
  return row.directory ? DIRECTORY_LABEL : row.name ?? fallbackName ?? row.subscriptionId;
}

/**
 * Lowest unrounded passing ratio first, then more findings, then name. A row with no counted rule has no
 * ratio and goes last. The ratios are compared by cross-multiplying, so no rounding decides the order.
 */
export function compareRows(a: SubscriptionRow, b: SubscriptionRow, labelOf: (row: SubscriptionRow) => string = rowLabel): number {
  if ((a.totalRules > 0) !== (b.totalRules > 0)) return a.totalRules > 0 ? -1 : 1;
  if (a.totalRules > 0) {
    const ratio = a.passingRules * b.totalRules - b.passingRules * a.totalRules;
    if (ratio !== 0) return ratio;
  }
  return b.activeFindings - a.activeFindings || labelOf(a).localeCompare(labelOf(b));
}
