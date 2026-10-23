# ADR 0016: A dashboard number is computed from the link it opens

Status: accepted, 2026-10-23 (spec "A widget catalogue where every number says what it counts and
links to it", map #320).

## Decision

**Every dashboard finding count and roll-up is computed by the Scans view engine, on the View
parsed from the widget's own href.** The widget builds its Scans link from its effective filters.
The server parses that same href back into a View and counts it, under the viewer's Access. The
number and the list it opens are one question asked twice, so they cannot disagree.

**The count goes through a count-only entry point.** It shares the slim read, the suppression
read, the row matcher and the group answer with the view query (ADR 0007), and skips only what a
count does not need: the page of rows and their long text. It is not a second implementation of
filtering.

**One read per tab per widget request.** A widget that counts Results reads the Results tab once,
and one that counts Advisories reads that tab once. A widget never reads a tab per number.

**No index is added.** If a count proves too slow, an index is a separate change, decided on its
own measurements.

## Trade-off

The decision buys equality with the Scans list at the price of a cheaper bespoke aggregate. A
`GROUP BY` written for the dashboard would be faster, and would drift from the Scans list the day
either one changed how it narrows by Access, treats a suppression, or matches a row filter. A
number that does not equal the list behind its link is the failure this feature exists to remove,
so equality wins.

## Consequences

- The dashboard's own narrowing and filter matching stop counting. Whatever the dashboard used to
  apply to findings itself is gone from the count path; a filter that Scans cannot express is a
  filter a dashboard widget cannot offer.
- A change to how Scans filters, groups or scopes a view changes the dashboard numbers in the same
  commit. There is nothing second to keep in step.
- Trend points are not computed this way. They are recorded values, never links, and do not use
  the view engine.

## Proof

The widget-equals-Scans-list MATRIX test. For each widget and each person in the matrix, scoped
and Everything, the widget's number must equal the total of the Scans list its href opens.
A widget without an entry fails the suite, as in `access-matrix.test.ts`.
