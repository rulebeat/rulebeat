# ADR 0012: Dashboards and saved views have an Owner and are Personal or Shared

Status: accepted, 2026-10-28 (builds on ADR 0010, ADR 0002 and ADR 0011).

## Decision

**Every dashboard and saved view has an Owner and a visibility of Personal or Shared.** There are no
lists of people, Roles or Scopes on an item. Lists would duplicate Access, go stale as Scopes and
people change, and leak who holds what. A filtered Shared item plus held-back values already gives
each reader only what their Access allows (ADR 0010: Access is Roles at Scopes, resolved once per
request).

**Creating makes a Personal item, and sharing is a deliberate step.** Any signed-in person, Viewer
included, keeps Personal items.

**Someone else's Personal item answers like an unknown id, an Admin included.** Nothing about it
shows, including its name.

**Who changes a Shared item follows the curation-on-Everything principle of ADR 0011.** A scoped
Editor changes only the Shared items they own. An Admin or an Editor on Everything changes any
Shared item, takes it over, and chooses the Install default, which must be Shared. There is no
automatic promotion: nothing becomes the Install default, or becomes Shared, without a person
choosing it. Each person may pick a My default; without one they land on the Install default, and
there may be none.

**Held-back values never leave the server.** A stored filter value outside the viewer's Access is
counted per place and dimension, never sent. Saves merge held-back values back against the current
revision, so a viewer who cannot see a value cannot lose it by saving. A held-back value never
widens a filter: it matches nothing for that viewer, and a dimension whose values are all held back
reads "Outside your access" rather than falling back to everything. A new value outside the saver's
Access is refused. Only an explicit, audited Remove N values action drops held-back values.

**Upgrade.** Every existing item becomes Shared, which is what they were. A saved view is owned by
its creator when that person still exists. A dashboard has no owner, because nothing records one.
The current default dashboard stays the Install default.

**The Demo accepts that Personal items are visible to every Visitor until the next Reset.** Every
Visitor is the same admin (ADR 0002), so there is no one to hide an item from, and the Reset is the
guardrail.

**Saved queries keep their own private or shared setting.** It is out of scope here.

## Considered options

- **Per-item lists of people, Roles or Scopes.** Rejected: they duplicate Access, go stale as people
  and Scopes change, and let a reader learn who holds what.
- **Guessing dashboard owners from the audit log.** Rejected: the log records a summary, not
  ownership, and a wrong guess hands an item to the wrong person.
- **Promoting the oldest dashboard to the Install default.** Rejected: age says nothing about
  which dashboard the install wants people to land on. The current default stays, and where there
  is none, an Admin or an Editor on Everything chooses.
- **A per-person count cap.** Rejected: Personal items are cheap, and a cap would block real work
  to solve a problem the install does not have.

## Consequences

- A Shared item with no owner is changed only by an Admin or an Editor on Everything.
- A Shared dashboard may use only Shared saved views. If a view it uses stops being Shared,
  everyone but its owner sees that it is no longer shared with them.
- Name uniqueness checks never reveal someone else's Personal names.
- Share, unshare, hand-over, take-over, default changes and value removal are audited. Sharing says
  that the name, description, widget titles and search text become visible to everyone.
- In the Demo, a Visitor sees and changes every Personal item until the Reset.
