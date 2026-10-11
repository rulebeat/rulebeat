/**
 * What the compare routes answer (ADR 0008), in one place for the module that builds it, the routes
 * that send it and the screen that reads it. No imports from the server, so a client component can use it.
 *
 * A Compare sets two snapshots of one category side by side, matched by fingerprint: a finding in the
 * newer scan only is Added, in the older scan only is Fixed, and in both is Persisted (listed as the
 * newer scan recorded it).
 */
import { SNAPSHOT_ERRORS, type SnapshotItem, type SnapshotScan } from './snapshot-response';

export const COMPARE_SIDES = ['added', 'fixed', 'persisted'] as const;
export type CompareSide = (typeof COMPARE_SIDES)[number];

/** How many findings each side holds, whichever side is on screen. */
export type CompareTotals = Record<CompareSide, number>;

export interface CompareResponse {
  /** The scan that started first and the one that started after it. The server decides which is which,
   *  so the two ids may be asked for in either order. */
  older: SnapshotScan;
  newer: SnapshotScan;
  side: CompareSide;
  totals: CompareTotals;
  /** The page listed: the one asked for, held to the pages that exist. */
  page: number;
  pageCount: number;
  pageSize: number;
  /** The side's findings on this page, in the snapshot's order. */
  items: SnapshotItem[];
}

/** The answers that are not a failure and not a list. `not-found` and `no-records` keep the snapshot's
 *  codes and statuses, so a client reads them the same way; the sentences are the compare's own, because
 *  a compare is about two runs and has to say that one of them is the problem. */
export const COMPARE_ERRORS = {
  'not-found': {
    status: SNAPSHOT_ERRORS['not-found'].status,
    body: {
      code: 'not-found',
      error: 'One of these two runs was not found. It may have aged out of Run History.',
    },
  },
  'no-records': {
    status: SNAPSHOT_ERRORS['no-records'].status,
    body: {
      code: 'no-records',
      error: 'One of these runs has no stored findings to compare. It was saved by an earlier version, and its stored findings could not be read when RuleBeat upgraded. The server log names the reason at startup. RuleBeat tries again at each start, so fix what the log names and restart.',
    },
  },
  'different-categories': {
    status: 400,
    body: { code: 'different-categories', error: 'These two runs are of different categories. Compare two runs of the same category.' },
  },
  'bad-request': {
    status: 400,
    body: { code: 'bad-request', error: 'A compare needs the ids of two runs, written as one id, two dots and another.' },
  },
} as const;

export type CompareErrorCode = keyof typeof COMPARE_ERRORS;
