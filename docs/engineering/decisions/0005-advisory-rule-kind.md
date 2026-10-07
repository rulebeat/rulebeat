# ADR 0005: Advisory is a rule kind, and advisories never count toward posture

Status: accepted, 2026-10-07.

## Decision

A rule has a kind: Problem, Activity or Advisory. Activity stays tied to the Logs backend. Problem
and Advisory are chosen in the rule details, default to Problem, and can be switched either way at
any time. Kind is its own field. It is not a severity, a category or a query backend, so an
advisory rule is an ordinary Resource Graph (or later Microsoft Graph) rule in an ordinary
category. A service retirement rule is a Resource Graph query over `advisorresources` in
Reliability.

An advisory rule produces one finding per affected resource, keyed `ruleId::resourceId` like every
other finding, with the same Open, New and Fixed lifecycle, suppressions and severity. A rule may
name a column that holds a deadline. Once that date passes the advisory is shown as overdue, and
it stays an advisory.

Advisories are left out of posture and out of every count that exists today: the Results tiles,
severity breakdowns, top rules, top resources, recent findings and stat cards. They are listed on
an Advisories tab on `/scans` and in an advisory dashboard widget. A schedule sends them only to a
channel whose "Include advisories" setting is on, and that setting is off by default.

On shipped rules the kind belongs to the install. An upgrade never sets or resets it, the same way
it never changes what an enabled rule runs (ADR 0004).

Advisory rules read only the tenant's own data through the credential RuleBeat already has. Public
feeds such as Azure Updates are out of scope.

## Why

Some results tell you something you need to act on without anything being misconfigured: a VM
size that retires next year, an Advisor cost recommendation. Counted as failures, they drag
posture down for something nobody can fix today, and the posture number stops meaning "what is
wrong with my estate". Hiding them behind the Info severity does not work, because Info is already
used for real failures of low weight.

## Considered options

- **Treat Info severity as advisory.** Rejected. Severity says how bad a problem is; it cannot also
  say whether something is a problem. Existing Info rules are real failures.
- **A fourth query backend or a separate advisory category.** Rejected. Where the data comes from
  and what area it covers are independent of what a result means, and both are already modelled.
- **One finding per recommendation, with resources as a list inside it.** Rejected. Per-resource
  findings reuse the existing key, lifecycle and suppressions, and let one resource be fixed while
  the others stay open.
- **Turn an overdue advisory into a problem automatically.** Rejected. A rule's meaning changing on
  a date is the kind of silent posture move ADR 0004 exists to prevent.
- **Ship advisory rules locked to the Advisory kind.** Rejected. Whether a retirement counts as a
  failure is the admin's call.

## Consequences

- Switching a rule's kind keeps its findings, their age, history and suppressions, because the key
  does not include the kind. Posture changes from the next scan; past snapshots are not rewritten.
  The switch is audited.
- Every query that counts findings has to filter on kind. A count that forgets to is a bug, and the
  tests that sum counts (tiles adding up to Open) are what catch it.
- Advisories with no resource id (Microsoft 365 Message Center, a later release) will be keyed by
  the rule's `dimensionKeyField`, as Logs findings already are. Message Center also needs a new
  Microsoft Graph permission, which is why it is not in the first release.
