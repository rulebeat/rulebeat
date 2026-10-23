# ADR 0012: Dashboards and saved views have an Owner and are Personal or Shared

Status: accepted, 2026-10-23 (map #320).

Builds on ADR 0010 (Access is Roles at Scopes), ADR 0002 (the writable shared Demo) and the
principle of ADR 0011 that what the whole install shares is curated on Everything.

## Decision

**Every dashboard and saved view has an Owner and a visibility of Personal or Shared.** There are no
lists of people, Roles or Scopes on an item. Lists would duplicate Access, go stale as Scopes and
people change, and leak who holds what. A filtered Shared item plus held-back values already gives
each reader only what their Access allows.

**Creating makes a Personal item, and sharing is a deliberate step.** Any signed-in person, a Viewer
included, keeps Personal items.

**Someone else's Personal item answers like an unknown id, an Admin included.** Nothing about it is
confirmed, including that its name is taken.

**A scoped Editor changes only Shared items they own.** An Admin or an Editor on Everything changes
any Shared item, takes it over and chooses the install default, which must be Shared. There is no
automatic promotion: no dashboard becomes the default because it is the oldest, or because the
default was deleted. After that the install may have no default.

**Held-back values never leave the server.** A stored filter value outside the viewer's Access is
sent as a count per place and dimension, never as the value. Saves merge the held-back values back
in, under a revision check. A save never widens a filter: a new value outside the saver's Access is
refused. Held-back values are dropped only by an explicit, audited action (Remove N values).

**Upgrade.** Every existing item becomes Shared. Saved views are owned by their creator when that
person still exists. Dashboards have no owner, because none was recorded. The current default stays
the default.

**The Demo accepts that Personal items are visible to every Visitor until the next Reset.** Every
Visitor is the same admin (ADR 0002), so Personal there is a label, not a boundary, and the Reset
clears it.

**Saved queries' own private/shared setting is out of scope.** It is left as it is.

## Considered options

- **Per-item lists of people, Roles or Scopes.** Rejected: they duplicate Access, go stale as Scopes
  and people change, and leak who holds what.
- **Guessing dashboard owners from the audit log.** Rejected: the log records who last acted, not who
  an item belongs to, and a wrong guess hands an item to the wrong person.
- **Promoting the oldest dashboard to be the default.** Rejected: age says nothing about which
  dashboard the install wants people to land on; an empty default is honest.
- **A per-person count cap.** Rejected: it adds a limit and a message for a problem nobody has had.

## Consequences

- An item with no owner is changed only by an Admin or an Editor on Everything, until one of them
  takes it over or hands it to someone.
- Sharing shows the name, description, widget titles and search text to everyone, and the name
  appears in the audit log, so the confirmation says so.
- Share, unshare, hand-over, take-over, default changes and value removal are audited.
