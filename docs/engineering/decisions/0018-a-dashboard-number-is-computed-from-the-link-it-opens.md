# ADR 0018: A dashboard number is computed from the link it opens

Status: accepted, 2026-11-07 (map #320, spec "A widget catalogue where every number says what it
counts and links to it").

## Decision

**Every dashboard finding count and roll-up is computed by the Scans view engine, on the View parsed
from the widget's own href.** The widget builds its link from its effective filters with
`buildScansHref()`. The server parses that same href back into a View and computes the number from
it, so the number and the list it opens are the same question asked once.

**It runs under the viewer's Access.** The count is narrowed in SQL by the same access filter the
Scans list uses, so a scoped viewer's number is the count of the list that viewer sees, not the
install's.

**Through a count-only entry point.** The view engine gains an entry that returns counts and group
answers without paging rows. It shares the slim read, the suppression read, the row matcher and the
group answer with the view query. It is not a second implementation of any of them.

**One read per tab per widget request.** A widget request reads the findings for the tab its View
is on (Results, Advisories or Activity) once, and every count and roll-up that widget shows is
taken from that read.

**No index is added.** The count reads what the Scans list reads. If it proves too slow, an index is
a separate change with its own measurements.

## Considered options

- **A bespoke aggregate per widget, written against the findings table.** It would be cheaper per
  request. Rejected: it is a second statement of what a filter means, so the dashboard and the list
  drift each time a filter, a suppression rule or the access filter changes. The trade-off is
  recorded: equality with the Scans list is bought at the price of a heavier read.

## Consequences

- The dashboard's own narrowing and its own filter matching stop counting. A widget no longer
  narrows by access or matches filters in code of its own; those live in the view engine only.
- A change to how Scans filters, groups or suppresses changes every dashboard number in the same
  release, because there is one implementation.
- Dashboard load time follows the cost of the view query on the tabs the widgets use. A slow
  dashboard is a slow Scans list, and is fixed in one place.
- A number that is not the count of a Scans list (a trend point, a median) is not computed this way,
  and its widget is not a link.

## Proof

The widget-equals-Scans-list test. Its `MATRIX` holds each linking widget with the viewers it is
checked for (Everything and a scoped viewer), fetches the widget's number, follows the widget's own
href to the Scans list and asserts the two counts are equal. A widget with a link and no entry fails
the suite.
