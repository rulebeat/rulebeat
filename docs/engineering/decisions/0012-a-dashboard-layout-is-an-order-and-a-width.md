# ADR 0012: A dashboard layout is an order and a width; content sets the height

Status: accepted, 2026-10-23 (feature "Audience templates and the Grid dashboard layout").

## Decision

**A layout is an ordered list of widgets, each with a span from a declared size table.** Widgets
flow left to right on a fixed 12-column grid in sparse flow: a widget that does not fit in the
rest of a row starts the next one, and a gap is left rather than filled by a later widget. The size
table names the spans each widget type may take, so every viewer sees the same layout.

**Content sets the height.** A row stretches to its tallest frame, and no frame scrolls inside.
A widget that grows makes its row taller; nothing is clipped and nothing overlaps.

**Stored layouts snap at render time and are never rewritten by rendering.** Widgets are ordered
by (y, x), with array order breaking ties. Each width snaps to the nearest allowed span, a tie
going to the smaller. A stored h is ignored. Nothing is written back until a person saves.

**A Save writes x and y from the placement and w as the span.** It keeps a stored h, or writes the
type's nominal h when there is none. The stored shape stays complete, so a build rolled back to the
previous layout code reads the dashboard without overlap.

**react-grid-layout is removed and nothing replaces it.** The flow is plain CSS grid plus the
order and the span, so there is no library to keep in step with it.

## Considered options

- **Free x and y placement with fixed per-type heights.** Rejected: it lets two people put the same
  widgets in layouts that no longer read in order, forces a height per type that either clips a
  long list or leaves a short one padded, and needs an inner scroll or a collision engine to cope
  with content that does not fit. An order and a width cannot overlap and cannot clip.

## Consequences

- Dragging a widget is a change of order, and resizing is a change between allowed spans, so both
  work from the keyboard as well as with a pointer.
- A layout saved by an older build still renders, snapped, and is only changed on its next Save.
- The size table is the one place that says what widths a widget may take. A new widget type adds
  a row to it.
