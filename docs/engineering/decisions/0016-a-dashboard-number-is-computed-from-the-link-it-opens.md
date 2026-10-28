# ADR 0016: A dashboard number is computed from the link it opens

Status: accepted, 2026-10-28 (map #320, spec "A widget catalogue where every number says what it
counts and links to it"). Builds on [ADR 0007](0007-views-run-on-the-server-rows-in-their-own-table.md)
and [ADR 0015](0015-stored-widgets-are-read-through-a-mapping.md).

## Decision

**Every dashboard finding count and roll-up is computed by the Scans view engine, on the View parsed
from the widget's own href, under the viewer's Access.** The widget builds its link with
`buildScansHref()` from its effective filters. The server parses that same href back into a View and
answers it. The number on the dashboard and the number at the top of the Scans list it opens come
from one View, one engine and one Access.

**A count-only entry point sits beside the view query.** It returns totals, group answers and facet
counts without paging in finding rows, and it shares the slim read, the suppression read, the row
matcher and the group answer with the view query rather than copying them. It is not a second
implementation of filtering.

**One read per tab per widget request.** A widget that counts findings on one tab reads that tab's
slim findings once, however many numbers it shows.

**No index is added.** The view query's reads stay as they are. If a dashboard count is too slow on
a large install, an index is a separate change with its own measurements.

## Why

A dashboard number that does not match the list it links to is the failure that costs trust: someone
clicks "12 critical" and finds 9. Two implementations of "which findings count" drift apart in the
suppression rules, the access filter, the row matching and the group answer, and each has been a
source of a bug. Computing from the link makes agreement a property of the design, not of two code
paths kept in step.

## Trade-off

Equality with the Scans list is bought at the price of a cheaper bespoke aggregate. A dedicated
`COUNT(*) ... GROUP BY` would read less than the view engine does. This decision accepts the slower
read for the guarantee, and relies on the one read per tab to keep it bounded.

## Consequences

- The dashboard's own narrowing and filter matching stop counting. The code that narrowed findings
  by a viewer's Access and matched widget filters for the dashboard is no longer on the path of any
  finding count, and goes when the last widget moves over.
- A filter the Scans page cannot express cannot be a widget filter, since the widget could not link
  to it.
- Proof: the widget-equals-Scans-list test in the access `MATRIX`. For each widget, for a scoped
  viewer and an Everything viewer, the number the widget route returns equals the total of the Scans
  list its href opens. A widget without an entry fails the suite.
