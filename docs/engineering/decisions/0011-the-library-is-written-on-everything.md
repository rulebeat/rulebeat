# ADR 0011: The library is written on Everything, and a query a person writes is limited by its request

Status: accepted, 2026-10-13 (issues #260, #262, #263, #264, map #254).

## Decision

**Only an Admin, or an Editor who holds Everything, changes what the whole install shares**: the
rules in the library, schedules and categories. Everything is one choice in the scope picker, not a
selection of every management group, so it keeps covering management groups and subscriptions
created later. Only manual access holds it. A mirror gives management groups, subscriptions and
resource groups, never Everything, so a mirrored Editor, even one with a role at the tenant root,
does not write the library.

**An Editor on a smaller scope works inside it.** They suppress the findings they can see, run
shared rules now, and write personal rules. A personal rule reaches the library only through a
library request that an Admin or an Editor on Everything approves, by copying it in as a new rule.
A personal rule is seen and run by its author only, by hand, never on a schedule, and keeps only
its latest run's results, which never appear in shared Results, Run History, dashboards or posture.

**A run covers the overlap of the rule's scope and the runner's access.** The rule's scope says
where it looks; the runner's access says where they may look; nobody sets the overlap by hand. A
run that covers less than Everything resolves findings only inside what it covered.

**A query a person writes is limited by its request, never by filtering its rows.** The Query page,
the rule editor's previews and personal rules send Resource Graph only the subscriptions and
management groups the person holds, picked from those and defaulting to all of them. The KQL is
never rewritten. Resource Graph cannot limit a request to a resource group, and a written query can
fake the columns a row filter would trust (`extend id = ...`), so a person whose access is only
resource groups writes no queries and no personal rules. They still see findings, suppress them and
run shared rules: a shared rule is written by someone on Everything, so its rows can be trusted and
are filtered to their resource groups.

**Every read goes through one access object.** Each request resolves the person's access once.
Every repository read of findings, or of anything derived from them, takes it as a required
parameter, and `createTenantContext(access)` limits every Azure request. The scheduler's Everything
access comes from a module no route or page may import, enforced by an architecture test. Where a
finding sits is stored when it is written; a management group is expanded to its subscriptions when
findings are read, from a cached hierarchy, because it covers whatever sits under it now.

## Considered options

- **Shared rules owned by a team.** A scoped Editor writes a shared rule whose scope fits inside
  theirs, and it runs on the schedule with no review. Rejected: the library stops being one curated
  set, names clash between teams, and every team's experiment runs in every scheduled scan.
- **Filtering the rows of a written query to the person's resource groups.** Rejected: the columns
  the filter reads are the query's own output, so the query can forge them, and an aggregate row has
  none to filter on.
- **Personal findings tracked through the findings lifecycle.** Rejected: it doubles the findings
  model for drafts and would strand history when a personal rule is copied under a new id.
- **Refusing Run now to scoped Editors.** Rejected: checking their own fix is the main thing a team
  Editor does.

## Consequences

- An Admin who wants someone to write the library grants them Everything by hand.
- A person who needs to write queries needs at least one subscription.
- Run History records the scope each run covered. Compare is offered only between two runs that
  covered the same scope.
- Posture trend history is kept per subscription, so a person whose access is only resource groups
  gets live posture with no trend. Whether snapshots gain a resource group grain is left to the
  dashboards work.
