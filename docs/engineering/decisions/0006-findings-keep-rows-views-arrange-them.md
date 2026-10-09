# ADR 0006: Rules gather data, a finding keeps every row, and views arrange them

Status: accepted, 2026-10-08. Supersedes the grouping and Deadline parts of ADR 0005. Partly
superseded by ADR 0007: the view engine runs on the server and rows live in their own table; the
model of findings, rows and views stands.

## Decision

A rule only gathers data. It never says how its findings are grouped, sorted or shown, and the
rule form shows the same fields whatever the rule's kind.

A finding is still one rule's result about one resource, keyed `ruleId::resourceId` (or the
dimension value, for an Activity rule). What changes is that a finding keeps every row the rule's
query returned for that resource, not just the last one. This applies to every rule kind and
every query backend.

A finding that gains a row it did not have before (compared on all its columns) counts as changed,
and a schedule notifies about it as it does for a New finding. A row that goes away, or a row
whose values change, is recorded in the finding's history; only the gained row notifies. The
finding is Fixed when no rows remain.

Grouping, filtering, columns, sort and drill-down belong to the app, as a **view**: one engine
that works on any finding from any rule, on its built-in fields and on any column a query
returned. Group by can be nested, and each group shows its resource count. The Results and
Advisories tabs are the same explorer; Advisories opens it filtered to Kind = Advisory. A view can
be saved under a name, and a saved view is shared with everyone on the install, the way dashboards
are. No views ship with RuleBeat or with packs for now.

Kind keeps one meaning: whether a finding is a failure. It decides posture, the problem counts and
whether a channel that leaves advisories out receives it. It has no say in storage or display.

The rule-level Deadline column and Overdue are removed. A date a query returns, such as a
retirement date, is an ordinary column a view can sort and filter on.

The view engine runs in the browser over the findings the page already loads, reading row columns
from the stored JSON. It is a pure function behind one interface, so it can move to the server
without changing views or URLs.

## Why

Some queries return more than one row for one resource: two service retirements on one VM, or an
APRL check that expands an AKS cluster's node pools. Today those rows collapse into one finding and
all but the last are lost before anything can show them, so no view can fix it. That is a storage
problem, and it exists for Problem rules as much as for Advisory rules.

The first attempt (a Group column on Advisory rules) put a display choice inside the rule. It
worked for one rule kind only, so switching a rule's kind stranded its settings, and one group
column could not express the several levels a real report needs (service, retiring feature, date).

## Considered options

- **A Group column on the rule, Advisory only.** Rejected for the reasons above.
- **A result key the rule declares, as a setting or a `key` column in the query.** Rejected. It is
  optional but easy to get wrong (a column that changes each scan reopens every finding, one that
  does not separate the rows still collapses them), it asks the author to know exactly what the
  query returns, and every pack query that expands rows would need editing.
- **The whole row as the identity.** Rejected. Adding a column to a query, or a value changing,
  would close and reopen every finding and lose its age and suppressions.
- **Keep collapsing.** Rejected. It silently loses rows.
- **Move returned columns into their own table, or filter on the server with JSON functions.**
  Deferred. The browser handles the scale seen so far, and both are a migration or two SQL dialects.

## Consequences

- A rule that returns several rows for one resource has one suppression, one age and one Fixed for
  all of them. You cannot suppress one retirement on a VM and keep the other.
- A finding's age is when the resource first appeared for the rule, not when a later row did.
- Nothing is re-keyed, so finding history and suppressions are untouched by the change.
- Every count that is about resources counts findings; a count that is about rows (resources per
  retirement) counts rows. A view's group counts resources.
- Per-row tracking can be added later as an opt-in the app suggests from the columns that actually
  differ, without changing this model.
- A page per resource (issue #188) is a view filtered to one resource across all rules.
- Columns a rule needs from outside its query, such as Advisor's retirement catalogue, would come
  from a lookup the rule declares (issue #189). They are still row columns, so views treat them the
  same.
