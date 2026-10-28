# ADR 0013: A dashboard's filters are saved on the item and changed in the URL

Status: accepted, 2026-10-28 (map #320). Numbered after ADR 0012, the ownership decision, which
lands first.

## Context

A dashboard's filter bar saved itself 500 ms after every pick, onto the dashboard row. On a shared
dashboard that meant one Editor narrowing the view to look at one subscription changed it for
everyone who opened it next. A Viewer, who may not write the dashboard, made the same picks and had
them discarded without a word.

Saved views were the other half of the problem. A link to one carried a full copy of its filters
in the address. A copy cannot carry a value the browser never receives: when the person who made
the link holds more Access than the person who opens it, the values the opener may not use are not
in the page to be copied, so the link can only drop them or widen the filter.

## Decision

**The saved filters live on the dashboard row or the saved view row.** They change only through an
explicit save by someone allowed to edit that item. The save is revision-checked: it names the
revision the person was looking at and is refused if the row has moved on. It is audited, with the
changed field names and never the values.

**Filter changes live in the address, as differences on top of the saved filters, one dimension at
a time.** They use the `/scans` encoding through `lib/finding-view.ts`.

- A dimension that is present in the address replaces the saved value for that dimension.
- A dimension that is missing inherits the saved value.
- A present dimension with an empty value is the explicit "any": it clears the saved value rather
  than inheriting it.
- A dimension whose values are all malformed inherits, as if it were missing.

**Nothing is kept per viewer.** A filter change lasts as long as the address that holds it. Closing
the tab, or opening the dashboard without the address, shows the saved filters.

**The effective filters are assembled on the server, in one function.** Its inputs are the item id,
the revision, the filter changes and a widget id. The result is the saved filters, then the filter
changes, then the widget's own override (replace, never intersect). Every number on the dashboard,
every widget link to Scans and Duplicate read that one result.

**A value the viewer cannot use is held back: counted, never named, never dropped, never widened.**
The bar says how many values are held back and not which. The filter keeps them, so the numbers stay
the numbers the filter describes, narrowed to what the viewer may see by their Access. This also
covers an address from a person with more Access that names values the opener does not hold: the
opener sees the count and gets no more findings than their own Access allows.

## Considered options

- **Per-viewer saved filters.** Each person's picks kept against their account. Rejected: it keeps a
  second copy of the filters per person per dashboard to explain, migrate and clean up, it makes two
  people looking at the same dashboard see different numbers with nothing in the address to say
  why, and a link cannot carry it.
- **Per-value add and remove in the URL.** The address says "add subscription A, remove tag B"
  against the saved list. Rejected: the meaning of a link changes whenever the saved list does, a
  value that has since left the list makes a remove that means nothing, and the explicit "any"
  becomes a remove of every value. A per-dimension replacement means the same thing against any
  saved filters.
- **Client-assembled filters.** The browser merges saved filters, changes and override, and sends
  the result to the widget routes. Rejected: the browser holds only the values its person may use,
  so the merge cannot keep a held-back value, and each widget would have its own merge to get wrong.

## Consequences

- Widget routes refuse assembled filter params. They take ids and filter changes only, and ask the
  one server function for the effective filters.
- A save against a stale revision is a conflict. It is reported to the person and never overwritten,
  and the bar and the widgets stay on one revision.
- Layout, rename and default writes never touch the saved filters.
- Duplicate copies the duplicator's effective filters as the copy's saved filters.
- Saved views follow the same contract on Scans: the address carries only the differences from the
  open view.
- An old saved-view link that carries a full copy of the filters still opens as bookmarked. Its
  dimensions are read as filter changes over the view's saved filters, so it shows what it showed
  when it was made, and no migration of the links is needed.
- The symmetry between `scans/page.tsx` `searchParams` and the URL sync in
  `findings-explorer-client.tsx` stays, because both read the same encoding.
