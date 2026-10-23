# ADR 0013: A dashboard's filters are saved on the item and changed in the URL

Status: accepted, 2026-10-23 (map #320). Numbered after ADR 0012, which lands first with the
ownership spec.

## Context

A dashboard's filter bar saved every pick after 500 ms. On a shared dashboard that meant one
person's narrowing changed what everyone else saw. A Viewer, who may not edit the dashboard, had
the same pick refused and then lost, so their change vanished without a word.

A saved view's link carries a full copy of its filters. That copy can only hold values the browser
was sent, and a person never receives values outside their Access, so a link built from a view
cannot carry what its author could see and the reader cannot.

## Decision

**Saved filters live on the dashboard row or the saved-view row.** They change only through an
explicit save, by someone allowed to edit the item. The save is checked against the item's
revision and written to the audit log. Looking at a dashboard, picking in the bar and refreshing
never write them.

**Filter changes live in the address as differences on top of the saved filters, one dimension at a
time.** A dimension that is present replaces the saved value. A dimension that is missing inherits
it. A present dimension with an empty value is the explicit "any", which clears the saved value
without being the same as missing. If every value in a dimension is malformed, the dimension is
treated as missing and inherits, so a damaged link shows the saved filters rather than an empty
page. The encoding is the one `/scans` already uses, through `lib/finding-view.ts`.

**Nothing is kept per viewer.** Filter changes belong to the address and to no one. Closing the tab
or sending the link are the only ways they travel.

**The server assembles the effective filters in one function.** Its inputs are the item id, the
revision, the filter changes and the widget id, and it returns the saved filters, then the filter
changes, then the widget's override, each replacing the one before. The browser never builds the
result. Every number, widget link and Duplicate reads the effective filters, and so will Present,
print and the "As seen by" stamp.

**A value the viewer cannot use is held back: counted, never named, never dropped and never
widened.** This holds for saved filters and for a link from someone with more Access. The page
says how many values are held back and shows the figures for what the viewer can use, and a held
value stays in the filter rather than falling away, so removing it never shows more than the
viewer's Access allows.

## Considered options

- **Saved filters per viewer.** Each person's picks stored against their own account. Rejected: it
  keeps state for every person on every dashboard, two people looking at one dashboard see
  different numbers with nothing on the page to say why, and a link no longer shows what the sender
  saw.
- **Per-value add and remove in the address.** The address lists values to add to, or remove from,
  the saved filters. Rejected: its meaning depends on the saved filters at the moment it is read,
  so a later save changes what an old link shows, and a removed value that has since vanished has
  no stated result. A whole dimension replaced is the same on every read.
- **Filters assembled in the browser.** The client merges the layers and sends the result to each
  widget route. Rejected: the client would need values it is never sent, each widget could merge
  differently and disagree on one page, and a widget route that trusts assembled parameters can
  be handed any filter.

## Consequences

- Widget routes take an item id, a revision and filter changes, and refuse assembled filter
  parameters.
- A save against an out-of-date revision is reported as a conflict, with nothing overwritten. The
  person chooses what to do next.
- A saved view link made before this change carries a full copy of its filters. It still opens as
  it was bookmarked.
- The 500 ms autosave and the write paths that set filters as a side effect of layout, rename and
  default changes are removed.
- Tests show that a link from a person with less Access cannot widen a filter, and that one with
  more Access does not name values to a viewer who cannot use them.
