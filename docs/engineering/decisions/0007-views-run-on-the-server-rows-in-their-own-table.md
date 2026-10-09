# ADR 0007: Views run on the server, and a finding's rows live in their own table

Status: accepted, 2026-10-09. Supersedes the placement part of ADR 0006 ("the view engine runs in
the browser") and decides its deferred option. ADR 0006's model stands: a finding keeps every row,
and views arrange them.

## Decision

A finding's rows move out of the finding into a table of their own, one record per row, in query
order, linked to the finding by its fingerprint. Each row is stored as JSON text, on SQLite and on
Postgres alike. The finding gains a row count. Nothing is re-keyed: fingerprints, ages,
suppressions and history are untouched. Every finding is stored this way, whatever its rule kind
or query backend, including a finding with one row.

The view engine runs on the server. One request per view change, computed in one pass over one
read of the database, returns everything the screen shows together: the page of findings, the
tiles, the group headers with their counts, the built-in filter values with their counts and the
list of returned columns. The numbers on screen therefore always agree with each other. Paging,
opening a group and opening a finding's further rows are new reads of the same view.

What the browser receives is bounded however large the estate is:

- A page is 50 findings, or 50 group headers at each level. A group's contents load when it is
  opened.
- A finding on a page carries its first 20 rows and its row count. The detail fetches further
  pages. No row is ever dropped; only how many are sent at once is limited.
- A returned column's filter values load when its dropdown opens, scoped to the current view: the
  100 most common, plus a search on the server for the rest. Built-in fields' values come with the
  view.
- The list of returned columns is kept per rule, rebuilt from the rule's stored rows whenever a
  scan saves its findings, so a column that only older or Fixed findings have stays offered.
- Export is a server route that takes the view and streams every row of every matching finding.

Search keeps its meaning (resource name, rule name, type and resource id, anywhere in the text,
case-insensitive) and runs in the database. Saved views and URLs do not change: the server reads
the same view from the same query string. After a scan, the explorer fetches the current view
again rather than reloading the page.

The pure view engine in `lib/finding-view.ts` stays as the reference. The server's results must
match it exactly (same findings, same order, same counts) on both databases, checked by a test
that runs the same views through both.

There is no cache of findings in server memory and no index of row values. SQLite gets a real page
cache and memory-mapping. An index on one column inside the rows' JSON can be added later, for a
column real installs filter on heavily.

The upgrade copies every finding's rows into the new table and proves the copy before anything
reads it: same row count per finding, same content, same order. A finding stored before rows
existed becomes one row made from its evidence; a finding with no evidence gets no rows. The old
columns stay filled but unread for one release, and are dropped in the next.

## Why

A benchmark on synthetic Azure Advisor-shaped data (about 1.5 KB per row, warm cache, one
machine) measured the browser design. At 10,000 findings with 3 rows on average, every visit to
`/scans` sent about 73 MB (5.8 MB gzipped) to the browser, on every tab. At 50,000 it sent about
364 MB and held about 420 MB in memory, near the browser's limit on string length. A filter change
with a row filter active took about 1.6 s in Node, and a browser is slower. The design
breaks at the size of estate the tool most needs to serve.

Rows inside the finding are the other half of the cost. Every count and every page read past them,
so at 50,000 findings a view with a row filter took about 1.5 s on the server too. With rows in
their own table the same view took about 260 ms, with the row column's filter values loading on
open, and saving a scan cost the same as before (about 90 ms per 1,000 findings).

Computing everything a view shows in one read is also faster than separate queries (1.5 to 2.7
times in the benchmark), so the integrity rule and the speed point the same way.

## Considered options

- **Keep the engine in the browser and only stop sending what no screen uses.** Rejected as the
  answer, kept as a first step. It removes about a third of the payload, and 10,000 findings still
  send about 50 MB.
- **Keep rows as JSON on the finding and filter them with SQL JSON functions.** Rejected. Every
  query still reads every row of every finding: about 0.7 s for one row filter at 50,000, no
  faster than filtering in code, and two SQL dialects to keep in step.
- **A cache of parsed findings in server memory, cleared by each scan.** Rejected. Fast, but the
  server holds about 420 MB at 50,000 findings, memory grows with the estate, and it depends on
  there being one replica (ADR 0001).
- **A table of every row value (one record per column of every row), indexed.** Rejected. It makes
  any row filter fast, but it takes about 2.4 times the row data on disk and makes saving a scan
  25 to 30 times slower, about 110 extra seconds for a full rescan at 50,000 findings. Views were
  only about 1.3 to 1.5 times faster than without it. A tool whose main job is scanning should not
  pay on every scan to save time on clicks.
- **Postgres `jsonb` for the rows.** Rejected. It reorders a row's keys and drops duplicate ones,
  so a row would no longer show its columns in the order the query returned them, and the two
  databases would store rows differently.

## Consequences

- The explorer no longer holds every finding, so anything that summed over "what the page loaded"
  asks the server instead. Tiles, counts and export all come from the view request or its export
  route.
- Opening a returned column's dropdown, a group or a finding's further rows is a short wait the
  browser design did not have.
- A row filter with no other filter still reads every row of the candidate findings. At 50,000
  findings that view is about 275 ms, and opening that column's dropdown up to about 0.7 s. If a
  real install needs better, the remedy is an index on that column, not a change to this model.
- The migration touches every finding. It follows the rule that an upgrade never disturbs data: it
  is proven by a content test, and the old columns remain for one release.
- Run History's snapshot and compare views read stored scan results, not the findings table, and
  are not covered here. They are a separate change.

## Decisions made while building it

Routes and response shapes:

- The column-values route takes its text search as `valueQuery`, not `q`, because `q` is the view's
  own search and a view and a column search travel together.
- The rows route answers 404 for a fingerprint that is not on the asked tab, rather than an empty
  page that looks like a finding with no rows.
- A facet option carries a `label` beside its `value`, so the browser shows rule names and
  subscription names without a second lookup.
- There is no status facet. Status has a fixed set of choices and its counts are the tiles.

Ordering:

- Findings that tie on the sorted value fall to the fingerprint, ascending, whichever way the sort
  runs. Without a fixed tie-break two pages of one view could repeat or skip a finding. The
  reference is held to the same order by the parity test.

How a view reads the database:

- The built-in side of a view (filters, search, window, suppression, facets, tiles, the by-rule
  rows, sort and paging) runs in TypeScript over one slim read of the tab's findings: no rows, no
  evidence, no long text. It uses the engine's own functions, so it cannot drift from the
  reference. Per-facet SQL was measured and rejected: at 50,000 findings the one slim read takes
  about 340 ms and a `GROUP BY` for one facet about 400 ms, so the dozen facets and tiles of a
  view would cost about 5 s.
- A view that looks at a row value (a row filter, or a sort or group on a returned column) streams
  the rows of its candidate findings in chunks of 500 fingerprints, parses each row once and keeps
  only a count of matching rows, plus the few values a sort or group reads. Nothing parsed is held
  past its chunk. A second phase reads all rows of the findings on the page and parses them again,
  so the cost is bounded by the page size.
- The candidates are the findings that fail at most one built-in filter, because only those can
  change a facet, tile or by-rule count. A finding that fails two is never read.
- Before a row is parsed its text is checked for the filter's value, when that value is plain text.
  The check can only skip a row that cannot match. A value that could be written other ways (a
  number, an object's text, an empty value) is not checked and the row is parsed.
- How many rows each finding holds comes from the `finding_rows` primary key index
  (32 to 45 ms at 50,000 findings), not from the finding's `row_count` column (500 to 616 ms).
  `row_count` is read for the findings on a page.
- A covering index on `findings` for the slim read was left as a later lever. It would speed one
  read that is a third of the default view, and every scan would pay for it.

Scan save:

- A scan rebuilds a rule's catalogue from the rows it just wrote. It reads stored rows only when a
  column could be missing: when the catalogue has not yet been proven built, or when the rows
  written dropped a column the rule had. It then reads only the rule's findings the scan did not
  rewrite. Only the entries that changed are written.

Measured on the benchmark harness, one machine, SQLite, 5 rows of about 1.5 KB per finding
(about 7.5 KB a finding, against about 4.5 KB for the 3 rows the figures above were taken on):

| 50,000 findings | today | server |
| --- | --- | --- |
| default view | 3.6 s | 0.8 s |
| row filter on one column | 3.6 s | 2.4 s |
| a column's values | 3.5 s | 2.2 s |
| peak memory | 2.4 GB | 0.7 GB |

A row-filtered view therefore costs more than the 275 ms above, which was taken on fewer and lighter
rows. Reading the text of 250,000 rows out of SQLite is the floor (about 0.75 s), and the rest is
the slim read, the pools and parsing the rows that pass the text check.
