/**
 * What the snapshot routes answer (ADR 0008), in one place for the module that builds it, the routes
 * that send it and the screen that reads it. No imports from the server, so a client component can use it.
 */
import type { ViewTab } from './view-response';

/** One finding of a snapshot as the scan saw it: the record in `scan_findings`, nothing derived. */
export interface SnapshotRecord {
  fingerprint: string;
  ruleId: string;
  severity: string;
  /** The rule's name as the scan saw it. */
  title: string;
  kind: string;
  resourceId: string | null;
  resourceName: string | null;
  resourceType: string | null;
  resourceGroup: string | null;
  subscriptionId: string;
  /** How many rows the finding held in this scan. The rows themselves are on the live finding. */
  rowCount: number;
}

/** The columns the snapshot table shows, in order, and the header each has on screen. The export's
 *  first columns are these same ones, so a file reads like the screen. */
export const SNAPSHOT_COLUMNS = [
  { key: 'severity', header: 'Severity' },
  { key: 'title', header: 'Rule' },
  { key: 'resourceName', header: 'Resource' },
  { key: 'resourceType', header: 'Type' },
  { key: 'resourceGroup', header: 'Resource group' },
  { key: 'rowCount', header: 'Rows' },
] as const satisfies ReadonlyArray<{ key: keyof SnapshotRecord; header: string }>;

/** What a file adds after the screen's columns: the rest of each record. */
export const SNAPSHOT_EXPORT_ONLY_COLUMNS = [
  { key: 'subscriptionId', header: 'Subscription' },
  { key: 'resourceId', header: 'Resource ID' },
  { key: 'ruleId', header: 'Rule ID' },
  { key: 'kind', header: 'Kind' },
  { key: 'fingerprint', header: 'Fingerprint' },
] as const satisfies ReadonlyArray<{ key: keyof SnapshotRecord; header: string }>;

export const SNAPSHOT_EXPORT_COLUMNS = [...SNAPSHOT_COLUMNS, ...SNAPSHOT_EXPORT_ONLY_COLUMNS];

/** One finding of a snapshot, as the scan saw it, and where its live finding is. */
export interface SnapshotItem extends SnapshotRecord {
  /** Whether a finding with this fingerprint still exists, whatever its status. */
  exists: boolean;
  /** The tab that lists the live finding. */
  tab: ViewTab;
}

export interface SnapshotFacetValue {
  value: string;
  /** What the value is called on screen: the rule's name for a rule, the value itself otherwise. */
  label: string;
  count: number;
}

export interface SnapshotScan {
  id: string;
  category: string;
  startedAt: string;
}

export interface SnapshotResponse {
  scan: SnapshotScan;
  /** Findings that match the filters, across every page. */
  total: number;
  /** The page listed: the one asked for, held to the pages that exist. */
  page: number;
  pageCount: number;
  pageSize: number;
  items: SnapshotItem[];
  /** Each facet counts with every filter but its own applied, and with the search applied. */
  facets: { severity: SnapshotFacetValue[]; rule: SnapshotFacetValue[] };
}

/** The two answers that are not a failure and not a list: the run is gone, or it is an older run whose
 *  findings could not be converted at upgrade. Each has its own status and a code the screen tells
 *  apart, and says why. */
export const SNAPSHOT_ERRORS = {
  'not-found': {
    status: 404,
    body: { code: 'not-found', error: 'This run was not found. It may have aged out of Run History.' },
  },
  'no-records': {
    status: 409,
    body: { code: 'no-records', error: 'The findings of this run are not available. The run was saved by an earlier version, and its stored findings could not be read when RuleBeat upgraded. The server log names the reason at startup. RuleBeat tries again at each start, so fix what the log names and restart.' },
  },
} as const;

export type SnapshotErrorCode = keyof typeof SNAPSHOT_ERRORS;