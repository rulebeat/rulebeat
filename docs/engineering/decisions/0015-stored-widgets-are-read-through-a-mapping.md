# ADR 0015: Stored widgets are read through a mapping, never rewritten

Status: accepted, 2026-10-28 (map #320, spec "A widget catalogue where every number says what it
counts and links to it"). Extends the dashboard config migration. Numbered 0015 because 0012 to 0014
belong to the earlier specs in the map.

## Decision

**One read-time mapping table decides how every stored widget renders.** It extends the dashboard
config migration and is the only place that knows what an old widget type, period or key became. A
stored dashboard row is read through it on every render and is never rewritten by the read.

- **A changed type renders in its new form.** It keeps its stored title, size and position, and its
  stored config is translated to the new type's config by the mapping.
- **A faithful replacement carries a Replaced note.** The note stays until someone saves the
  dashboard and a revision-checked save writes the mapped form. The revision check on dashboard
  saves is not in place yet: it arrives with a later spec in the map, and this decision relies on it
  rather than describing it as current behaviour. Until it lands, a save writes the stored form
  as it does today. The note is a fact about the stored row, so it shows to everyone until the
  mapped form is written.
- **A retired type renders a Retired frame.** The frame says the catalogue no longer offers the
  widget and shows no number. Saving the dashboard writes the stored widget unchanged. A retired
  widget is never dropped.
- **An unknown type renders Unavailable.** A type the build has never heard of (a row written by a
  newer release) shows the Unavailable state, and a save writes it unchanged.
- **A stored period becomes a window override of literal days.** A widget that stored "7d" reads as
  a window set on this widget of seven days, so the number it shows is the number it showed.
- **Keys no longer offered survive saves.** A config key the mapping does not translate stays in the
  stored config and is written back as it was.
- **The title is kept, with one exception.** Every widget keeps the title its row stores. The one
  exception is "Healthy Categories", whose stored title would now say the opposite of what the
  widget counts, so it renders under the new type's title.

## Why

A dashboard is something a person built and may have shared. A release that changes the widget
catalogue must not change what is on their page, lose a widget or fail to open it. Reading through a
mapping gives the new renderer one shape to deal with while the row stays what the person saved, so
going back to the previous release finds every dashboard as it was.

## Considered options

- **A one-time migration that rewrites the stored rows.** Rejected. It cannot be undone by going
  back a release, it has to guess for a widget it cannot translate, and it loses the row of a
  retired type. The migration rules for `migrate.ts` say an upgrade must never disturb a user's
  existing data.
- **A per-viewer dismissal of the Replaced note.** Rejected. It needs a table for a note that ends
  anyway at the next save, and two people looking at the same dashboard would see different pages.

## Consequences

- The mapping table is permanent. A type that has been mapped once stays in it, since a row written
  by any earlier release can still be stored.
- A test per mapping entry proves a stored row renders as stated and that a read changes no stored
  byte.
- The Replaced note can sit on a dashboard nobody saves. That is accepted: the number is right, and
  the note says what changed.
