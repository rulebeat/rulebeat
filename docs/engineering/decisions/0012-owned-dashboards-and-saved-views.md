# ADR 0012: Dashboards and saved views have an Owner and are Personal or Shared

Status: accepted, 2026-10-23 (map #320). Builds on ADR 0010 (access is roles at scopes), ADR 0002
(the writable, shared Demo) and the principle of ADR 0011 that what the whole install shares is
curated on Everything.

## Decision

**Every dashboard and saved view has an Owner and a visibility of Personal or Shared.** There are no
lists of people, Roles or Scopes on an item. Lists would duplicate Access, go stale as Scopes and
people change, and leak who holds what. A filtered Shared item plus held-back values already gives
each reader only what their Access allows.

**Creating makes a Personal item.** Sharing is a deliberate step, never a side effect of saving.

**Someone else's Personal item answers like an unknown id**, an Admin included. The same holds for
name checks: a clash never reveals someone else's Personal name.

**Who changes what.** Any signed-in person, a Viewer included, keeps Personal items. A scoped Editor
changes only the Shared items they own. An Admin or an Editor on Everything changes any Shared item,
takes it over, and chooses the Install default, which must be Shared. This is ADR 0011's rule applied
to dashboards: what the whole install shares is curated on Everything. There is no automatic
promotion: nothing becomes the Install default or Shared by age, use or a person leaving.

**Defaults.** Each person may pick a My default, their own Personal item or any Shared one. Without
one they land on the Install default, and there may be none. Nothing is stored per Role or Scope.

**Held-back values never leave the server.** A stored filter value outside the viewer's Access is
sent as a count per place and dimension, never as the value. On read the server adds the held-back
values back to what it filters by, and on save it merges them back into the stored filter under a
revision check, so a save made from a stale copy is refused rather than overwriting. A held-back
value never widens a filter: it matches nothing for that viewer, and a dimension whose values are all
held back shows "Outside your access" instead of every row. A new value outside the saver's Access is
refused. Only an explicit, audited Remove N values action drops held-back values.

**Upgrade.** Every existing item becomes Shared. A saved view is owned by its creator when that
person still exists, and otherwise has no owner. A dashboard records no creator, so every existing
dashboard has no owner. The current default stays the Install default. No row or config is dropped.

**The Demo accepts that Personal items are visible to every Visitor** until the next Reset, because
every Visitor is the same admin (ADR 0002) and the Demo has no per-Visitor isolation.

## Considered options

- **Per-item lists of people, Roles or Scopes.** Rejected for the reasons above.
- **Guessing dashboard owners from the audit log.** Rejected: the log records who acted, not who
  meant to own, it may have been trimmed, and a wrong guess hands an item to the wrong person.
- **Promoting the oldest dashboard to Install default.** Rejected: age says nothing about which
  dashboard the install wants people to land on. The current default stays, and there may be none.
- **A per-person count cap on Personal items.** Rejected: it adds a limit and an error path to guard
  against a problem nobody has, and the Demo's Reset already bounds abuse there.

## Consequences

- A Shared item with no owner is changed only by an Admin or an Editor on Everything, until one of
  them takes it over.
- Stored values a reader does not hold stay in the item. Removing them is a deliberate, audited act
  by someone who can see the effect through its count.
- A Shared dashboard may use only Shared saved views. If a view it uses stops being Shared, everyone
  but that view's owner is told so rather than shown a wider result.
- Saved queries keep their own private or shared setting, which this decision leaves unchanged.
