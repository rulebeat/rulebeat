# ADR 0016: A dashboard number is computed from the link it opens

Status: accepted, 2026-10-29. Part of the widget catalogue spec, map #320. Builds on ADR 0007
(views run on the server) and ADR 0010 (access is roles at scopes).

## Context

A dashboard number that links to Scans must equal the count of the list it opens, for the same
viewer. Today the dashboard counts with its own narrowing and filter matching, a second
implementation of what the Scans view engine already does. Any difference between the two shows up
as a number that disagrees with the list behind it, and it differs most for a viewer whose Access
is scoped.

## Decision

**Every dashboard finding count and roll-up is computed by the Scans view engine**, on the View
parsed from the widget's own href, under the viewer's Access. The href is built by
`buildScansHref` from the effective filters; the same href is what the widget renders as its link
and what the server reads to compute the number, so the two cannot drift.

The engine gets a **count-only entry point** that shares the slim read, the suppression read, the
row matcher and the group answer with the view query. It returns the count or the roll-up without
paging rows. Sharing those pieces, not copying them, is what makes the equality structural.

**One read per tab per widget request.** A widget that needs Results and Advisories makes one read
for each tab, not one per number.

**No index is added.** If a count proves slow, an index is a separate change with its own
measurements.

## Trade-off

Equality with the Scans list is bought at the price of a cheaper bespoke aggregate. A purpose-built
`GROUP BY` over the findings table would be faster than running the view engine's slim read and
matcher, and was rejected because it is a second statement of what a filter means, which is the
bug this decision removes.

## Consequences

- The dashboard's own narrowing and filter matching stop counting. They are removed from the count
  path; there is one place that decides whether a finding matches a View.
- Access is applied the way Scans applies it, so a scoped viewer's dashboard number is the number
  on their Scans list, and a viewer who holds nothing that a widget covers sees Outside your access
  rather than a zero.
- A change to how Scans filters changes the dashboard in the same commit, with no second
  implementation to update.

## Proof

The widget-equals-Scans-list `MATRIX` test. For every widget that counts findings, it computes the
widget's number and the count of the Scans list its href opens, for an Everything viewer and a
scoped viewer, and fails when they differ.
