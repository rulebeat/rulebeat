# ADR 0012: Dashboards and saved views have an Owner and are Personal or Shared

Status: accepted, 2026-10-23. Supersedes the visibility part of ADR 0006 ("a saved view is shared with
everyone on the install, the way dashboards are"): a saved view is now Personal or Shared, and has an
Owner. ADR 0006's model of findings, rows and views stands.

Builds on ADR 0010 (Access is Roles at Scopes), ADR 0002 (the writable shared Demo) and the
curation-on-Everything principle of ADR 0011 (only an Admin or an Editor on Everything changes what
the whole install shares).

## Decision

**Every dashboard and saved view has an Owner and a visibility of Personal or Shared.** There are
no lists of people, Roles or Scopes on an item. Lists would duplicate Access, go stale as Scopes
and people change, and leak who holds what. A filtered Shared item plus held-back values already
gives each reader only what their Access allows.

**Creating makes a Personal item, and sharing is a deliberate step.** Nothing becomes Shared as a
side effect of saving, duplicating or opening it.

**Someone else's Personal item answers like an unknown id, an Admin included.** An Admin runs the
install, not other people's drafts, and a different answer for "exists but not yours" would reveal
that the item is there.

**Who changes what.** Any signed-in person, a Viewer included, keeps Personal items. A scoped
Editor changes only the Shared items they own. An Admin or an Editor on Everything changes any
Shared item, takes it over, and chooses the Install default, which must be Shared. There is no
automatic promotion: nothing becomes the Install default because it is the oldest, the most opened
or the last one standing. Each person may pick a My default, otherwise they land on the Install
default, and nothing is stored per Role or Scope.

**Held-back values never leave the server.** A stored filter value outside the viewer's Access
(see Held-back value in `CONTEXT.md`) is sent to the browser only as a count per place and
dimension. On read and on save the server merges the held-back values back into the item under a
revision check, so a person who cannot see a value neither loses it nor overwrites a change made
since they opened the item. A held-back value never widens a filter: it matches nothing for that
viewer, and a dimension whose values are all held back shows "Outside your access" rather than
everything. A value the saver does not hold is refused when it is new. Held-back values are dropped
only by an explicit, audited Remove N values action.

**Upgrade.** Every existing item becomes Shared and the current default stays the Install default.
A saved view is owned by its creator when that person still exists, and has no owner otherwise. A
dashboard records no creator, so every existing dashboard has no owner and the Admins and Editors
on Everything look after it.

**The Demo accepts that Personal items are visible to every Visitor until the next Reset.** Every
Visitor is the same admin (ADR 0002), so Personal cannot hide an item from anyone there. The Reset
is the guardrail, as it is for every other write.

**Saved queries keep their own private or shared setting.** It is out of scope here and is not
changed by this decision.

## Considered options

- **Per-item lists of people, Roles or Scopes.** Rejected: they duplicate Access, go stale as
  people and Scopes change, and show who holds what.
- **Guessing dashboard owners from the audit log.** Rejected: the log records a summary and field
  names, was never meant as an ownership record, and a wrong guess hands an item to the wrong person.
- **Promoting the oldest dashboard to the Install default.** Rejected: age says nothing about which
  dashboard suits the install, and the default is a choice for someone on Everything.
- **A per-person count cap on Personal items.** Rejected: it adds a limit to explain and tune
  without protecting anything Access does not already protect.

## Consequences

- Dashboards carry an owner, a visibility and a revision in storage, and an upgrade must keep every
  row and its config.
- A Shared dashboard may use only Shared saved views, checked on every save. If a view it uses stops
  being Shared, everyone but its owner sees that the saved view is no longer shared with them.
- Audit entries cover share, unshare, hand-over, take-over, default changes and value removal.
- A Shared item without an Owner is changed only by an Admin or an Editor on Everything.
