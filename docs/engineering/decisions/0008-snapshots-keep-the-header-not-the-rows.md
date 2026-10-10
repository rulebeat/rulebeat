# ADR 0008: A snapshot keeps each finding's header, not its rows

Status: accepted, 2026-10-10. Decides the Run History part ADR 0007 left out. ADR 0006's model and
ADR 0007's server view stand.

## Decision

A scan stores its snapshot as one slim record per finding in a `scan_findings` table: the scan id,
the fingerprint, and the rule id, severity, title, kind, category, resource id, name, type and
group, subscription and row count the finding had in that scan. The rows themselves are not kept
per scan. A finding's rows belong to the finding as it is now, in `finding_rows`.

Run History reads `scan_findings` and never the stored scan blob:

- A snapshot is a paged table on the server, 50 findings a page, with severity, rule and search
  filters and an export streamed from the same records. It shows every finding the scan returned,
  whatever is suppressed now, and has no Suppress, no script and no status.
- A finding in a snapshot links to the live finding on its own tab, which shows its current rows
  and status. A finding that no longer exists is listed without a link.
- Compare computes added, fixed and persisted in the database, by fingerprint, and pages each one.
  Its export streams the active one.

Retention stays at 90 scans a category (`SCAN_HISTORY_LIMIT`). Pruning a scan deletes its
`scan_findings` records with it. A deleted rule's records stay, so a past run keeps its counts. A
rule id change rewrites `rule_id` and `fingerprint` in `scan_findings`, like every table derived
from an id.

The whole findings blob each scan stores today goes, in two releases, the way the old row columns
went in ADR 0007:

1. The first release writes `scan_findings` at every save and converts every stored scan's blob
   into records on upgrade, one transaction per scan, proven by a content test. It keeps writing
   and keeping the blob, so going back to the previous release loses nothing.
2. The next release stops writing the blob and empties the stored ones. It runs only after the
   one-time upgrade backfills that still read blobs (findings and posture trend) have run.

## Why

At 50,000 findings on the benchmark data (5 rows of about 1.5 KB per finding), the largest
category held 22,909 findings with 114,366 rows. Opening one of its snapshots parsed and sent
about 184 MB to the browser in about 1 s and grew the server heap by about 1.1 GB, and a compare
did that twice: about 370 MB in about 2.1 s. At 10,000 findings a snapshot was still 37 MB.
Every page of that is spent on rows, and the rows are what nobody reads in a snapshot: it answers
"what was failing that day, and how bad", which the header answers.

The header is frozen so that history stays true. A rule renamed or re-graded later does not
rewrite what an old run said. The rows are not frozen, and the screen says so by sending you to
the live finding for them rather than showing current rows on a page about the past.

## Considered options

- **Page the stored blob on the server.** Rejected. The browser gets a page, but every request
  still parses the whole blob: about 1 s and 1.1 GB of heap a snapshot at 50,000 findings, twice
  for a compare.
- **Keep every row per scan in a table.** Rejected. It is a faithful copy, but at the benchmark's
  sizes it is about 170 MB a scan for the largest category, times 90 scans: on the order of 15 GB
  for history nobody reads row by row. An estimate, not measured.
- **Keep only the fingerprint per scan and join everything else from `findings`.** Rejected. It is
  the cheapest, but a renamed rule or a changed severity would rewrite every past run, and a
  deleted finding would leave a past run with nothing to show.
- **Use the server view for snapshots.** Rejected. A snapshot has no status, no window and no
  rows, and suppressing from a screen about the past acts on the present. A second source would
  also have to be held equal to the reference engine by the parity test.

## Consequences

- Run History stops sending rows. A snapshot's detail is one click away, on the live finding, and
  a finding fixed and gone since has none.
- Each scan save adds one bulk insert of slim records. Its cost is measured with the benchmark
  when it is built.
- `scan_findings` grows with retention: about 300 bytes a finding a scan, so on the order of
  600 MB for the largest category at 50,000 findings over 90 scans. An estimate, not measured.
  Dropping the blob saves far more than that.
- The first start after the first release converts every stored blob, so it is slower once.
- After the second release a stored scan holds no findings of its own. Anything that wants them
  reads `scan_findings`.
