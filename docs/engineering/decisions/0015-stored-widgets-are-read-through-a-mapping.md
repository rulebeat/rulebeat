# ADR 0015: Stored widgets are read through a mapping, never rewritten

Status: accepted, 2026-10-23 (spec "A widget catalogue where every number says what it counts and
links to it", map #320).

## Decision

**One read-time mapping table decides how a stored widget renders.** It extends the dashboard
config migration and is the only place that knows a widget type changed, went or never existed. The
stored row is the input and is not touched by reading it. What the table says for each case:

- **A changed type renders in its new form** with its stored title, size and translated config. The
  person sees the widget they placed, built on the new catalogue.
- **A faithful replacement carries a Replaced note** on the widget until a revision-checked save
  writes the mapped form. The note belongs to the dashboard, not to the viewer, so it is gone for
  everyone once someone saves. Saving goes through the dashboard's revision check, so a save made
  from an out-of-date copy is refused like any other.
- **A retired type renders a Retired frame.** It shows its stored title and no number, is saved
  unchanged and is never dropped from the dashboard.
- **An unknown type renders Unavailable**, the same way, and is saved unchanged. An unknown type is
  one this build has never heard of, such as a widget saved by a newer release.
- **A stored period becomes a window override of literal days.** A saved "7d" is a window Set on
  this widget, so it replaces the dashboard's window and stays rolling.
- **Keys no longer offered survive saves.** A config key the catalogue stopped offering is kept
  in the stored config and written back as it was, so a downgrade or a later widget that offers it
  again finds it.
- **The one title exception is "Healthy Categories".** Every other widget keeps its stored title,
  whatever the new catalogue calls the type. A stored "Healthy Categories" renders under the title
  of the widget that replaces it.

## Why

A dashboard is something a person arranged and named. A release that changes the catalogue must
not change what is on it behind their back, and must not lose a widget the build cannot draw. A
read-time mapping keeps the stored row as the record of what the person placed, so the rule in
`CLAUDE.md` holds: an upgrade never disturbs a user's existing configuration or data.

## Considered options

- **A one-time migration that rewrites the rows.** Rejected. It cannot be undone, it would drop
  or reshape widgets the new build has no form for, and a rewrite that goes wrong on someone's
  dashboard is silent and permanent. A mapping can be corrected in a later release and applies to
  every row, including those restored from a backup.
- **A per-viewer dismissal of the Replaced note.** Rejected. It needs a table of who dismissed
  what, and leaves one dashboard showing a note to some people and not to others. The note goes
  when the dashboard is saved in its mapped form, for everyone.

## Consequences

- Every widget type ever stored needs an entry in the mapping table, or it falls to Unavailable.
  A test per stored type proves a stored row renders in the form the table gives it. A test per
  retired and unknown type proves its row is saved unchanged.
- A dashboard nobody saves keeps showing the Replaced note. That is deliberate: the note is
  the prompt to save.
- The Retired frame and the Unavailable frame keep the widget in place, so removing one is a
  person's action, never a release's.
