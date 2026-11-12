# ADR 0012: Dashboards and saved views have an Owner and are Personal or Shared

Status: accepted, 2026-10-29 (map #320).

Builds on ADR 0010 (Access is Roles at Scopes), ADR 0002 (the writable shared Demo) and the
curation-on-Everything principle of ADR 0011.

## Decision

**Every dashboard and saved view has an Owner and a visibility of Personal or Shared.** There are
no lists of people, Roles or Scopes on an item. A list would duplicate Access, go stale as Scopes
and people change, and leak who holds what. A filtered Shared item plus held-back values already
gives each reader only what their Access allows.

**Creating makes a Personal item.** Sharing is a deliberate step, never a side effect of saving.

**Someone else's Personal item answers like an unknown id**, an Admin included. Name checks never
reveal another person's Personal names.

**Who changes what.** A scoped Editor changes only Shared items they own. An Admin or an Editor on
Everything changes any Shared item, takes it over and chooses the Install default, which must be
Shared. There is no automatic promotion: nothing becomes shared, owned or the default because it is
old, popular or the only one left.

**Held-back values never leave the server.** A stored filter value outside the viewer's Access is
returned only as a count per place and dimension. The server merges held-back values back on read
and on save, under a revision check, so a save made from a trimmed copy cannot lose them. A held-back
value never widens a filter: a dimension whose values are all held back matches nothing for that
viewer. A new value outside the saver's Access is refused. Only an explicit, audited Remove N values
action drops held-back values.

**Upgrade.** Every existing item becomes Shared. A saved view is owned by its creator when that
person still exists. A dashboard has no Owner. The current default stays as the Install default.
The upgrade must leave every row and its config intact, on SQLite and on Postgres.

**The Demo accepts that Personal items are visible to every Visitor until the next Reset.** Every
Visitor is the same admin (ADR 0002), so there is no one to hide a Personal item from.

**Saved queries keep their own private/shared setting.** It is out of scope here.

## Why

Access (ADR 0010) already says what each person may see, and a Shared dashboard is only a filter
over findings. Storing a second statement of who may see an item would have to be kept in step with
the first and would show who holds which Scope. Making the filter itself access-aware, and counting
what it holds back instead of showing it, keeps one source of truth.

Changing what the whole install shares is curation, and ADR 0011 gives that to an Admin or an Editor
on Everything. An Editor on a smaller Scope keeps ownership of what they shared, so a team can look
after its own dashboards without owning the install's.

## Considered options

- **Per-item lists of people, Roles or Scopes.** Rejected: duplicates Access, goes stale, and leaks
  who holds what.
- **Guessing dashboard owners from the audit log during the upgrade.** Rejected: the log is a record
  of events, not of ownership, and a wrong guess hands someone control of an item.
- **Promoting the oldest dashboard to Install default when there is none.** Rejected: a default
  chosen by age is a decision no one made. There may be none.
- **A per-person count cap on Personal items.** Rejected: it protects nothing Access does not
  already bound, and it makes a person delete work to make room.

## Consequences

- A Shared item can have no Owner. Only an Admin or an Editor on Everything changes it.
- A dashboard shown to someone with narrower Access than its author can look emptier or smaller for
  them. The page says a dimension is held back and how many values, never which.
- Deleting a person leaves their Shared items without an Owner and removes their Personal ones from
  sight.
- In the Demo a Visitor can open another Visitor's Personal item until the Reset.
