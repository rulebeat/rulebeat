# ADR 0017: Stored widgets are read through a mapping, never rewritten

Status: accepted, 2026-11-07 (map #320, spec "A widget catalogue where every number says what it
counts and links to it").

## Decision

**One read-time mapping table decides how a stored widget renders.** It extends the dashboard config
migration (`migrateDashboardConfig()`), which already runs on every read and never writes. The
catalogue changes which widget types exist; a dashboard saved before the change keeps rendering
under the new renderer, and no stored row is rewritten by the upgrade.

**A changed type renders in its new form.** It keeps its stored title and size, and its stored config
is translated into the new type's config. A stored period becomes a window override of literal days,
set on this widget. Config keys the new type no longer offers are kept, not dropped, and survive a
save.

**A faithful replacement carries a Replaced note.** When the new form says the same thing as the old
one, the widget shows a note that it was replaced. The note stays until someone saves the dashboard
through the normal revision-checked save, which writes the mapped form. The note is not dismissed
per viewer: it describes the stored row, so it is the same for everyone until the row changes.

**A retired type renders a Retired frame.** The frame keeps the stored title and size, shows no
number, and says the widget is no longer offered. The row is saved unchanged and never dropped by a
save, so nothing a person built is lost without their choosing to remove it.

**An unknown type renders Unavailable and is saved unchanged.** A type this build has never heard of
(a row from a newer release, or a hand edit) is shown as Unavailable with its stored title and is
written back as it was read.

**The one title exception is "Healthy Categories".** Every other mapped widget keeps its stored
title. The stat card stored with that title becomes "Categories with open findings", which counts
the opposite of what its old title says, so keeping the stored title would label the number
falsely. A stored title of "Healthy Categories" is shown as "Categories with open findings"; a title
the person changed to anything else is kept.

## Considered options

- **A one-time migration that rewrites stored rows to the new types.** Rejected: an upgrade must
  never disturb a user's existing configuration, a rewrite cannot be undone once a dashboard has
  been saved on top of it, and a downgrade would read types it does not know. The mapping gives the
  same result at render time and leaves the row as the person last saved it.
- **A per-viewer dismissal of the Replaced note.** Rejected: it needs a table of who dismissed what,
  and two people looking at one dashboard would see different pages. Saving the dashboard is the
  one act that clears the note, and it is the act that makes the note true.

## Consequences

- The mapping table is data, tested by loading a dashboard saved by an earlier release and checking
  that the title, size and translated config render and that the stored row is byte for byte
  unchanged after a read.
- A save writes the mapped form, so a dashboard that has been saved once no longer needs the
  mapping for its changed widgets. Retired and unknown widgets stay in the mapping for as long as
  their rows exist.
- A downgrade after a save reads types an older release may not know. That release frames them as
  unknown, which is the same behaviour this decision asks of this one.
- Not rewriting rows means a retired type's stored config is kept for good, including keys that
  nothing reads.
