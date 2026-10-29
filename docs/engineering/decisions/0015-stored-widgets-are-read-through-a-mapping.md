# ADR 0015: Stored widgets are read through a mapping, never rewritten

Status: accepted, 2026-10-29. Part of the widget catalogue spec, map #320.

## Context

The widget catalogue changes the 13 widgets: some change type, some are merged, some are retired,
and a stored dashboard can hold a type the running build has never heard of (a row written by a
newer release, then downgraded to). A dashboard a person built must keep rendering after an
upgrade, and an upgrade must never disturb a user's existing configuration.

## Decision

**One read-time mapping table extends the dashboard config migration.** For every stored widget
type it says one of four things: this type is the same, it is now another type, it is retired, or
(for any type it does not list) it is unknown. The renderer reads every stored widget through that
table. No row is rewritten by the upgrade.

- **A changed type renders in its new form** with its stored title, size and translated config.
- **A faithful replacement carries a Replaced note** until a revision-checked save writes the mapped
  form. The note belongs to the dashboard, not to the person looking at it, so it goes when the
  dashboard is saved and not before.
- **A retired type renders a Retired frame.** The frame shows the title and says the widget is no
  longer offered. It shows no number. It is saved unchanged and never dropped.
- **An unknown type renders Unavailable** and is saved unchanged.
- **A stored period becomes a window override of literal days.** A widget that held "7d" reads as a
  window set on that widget of 7 days, replacing the dashboard's window.
- **Keys no longer offered survive saves.** A config key the new form does not use is carried
  through a save untouched, so a downgrade finds what it left.
- **The one title exception is "Healthy Categories".** Its stored title described the old widget
  and would mislabel the new one, so it is replaced by the new type's title. Every other stored
  title is kept as typed.

## Alternatives rejected

- **A one-time migration that rewrites the rows.** It loses the stored form for good, so a
  downgrade, or a restore of a backup beside a newer build, finds widgets it cannot read. It also
  has to guess at every shape in the wild at upgrade time, where a read-time mapping only has to be
  right for the shape in front of it. Both break the rule that an upgrade must never disturb a
  user's existing configuration.
- **Per-viewer dismissal of the Replaced note.** It needs a table of who dismissed what, and two
  people looking at one dashboard would see different pages. A revision-checked save by someone who
  can edit the dashboard is the one event that settles the note for everyone.

## Consequences

- The mapping table is the single place a type's fate is decided. Retiring or changing a type later
  is one entry there, with a test that a stored row of the old type still renders and saves
  unchanged.
- A dashboard nobody saves keeps its Replaced notes. That is intended: the note says the stored
  form differs from what is shown, and that stays true until a save.
- A Retired widget is not a Retired rule. A Retired rule keeps running; a Retired widget keeps its
  row and shows nothing. The word means the same on both: RuleBeat no longer offers it and leaves
  it where it is.
