# ADR 0013: A dashboard's filters are saved on the item and changed in the URL

Status: accepted, 2026-11-07 (spec "Dashboard filters in two layers: saved on the dashboard, changes in the URL", map #320).

## Context

A dashboard's live filters used to autosave 500 ms after each change. On a shared dashboard that let
one person's narrowing change what everyone else saw, and it dropped a Viewer's picks, since a
Viewer may not write the dashboard. A saved view had the opposite problem: its link carried a full
copy of its filters, and a copy can only hold values the browser received. A value held back from
the person who built the link is missing from it, so the link opens a narrower or wider view than
the one saved.

## Decision

**Saved filters live on the dashboard row or the saved-view row.** They change only through an
explicit save that is checked against the item's revision and written to the audit log, by someone
allowed to edit that item. Moving a layout, renaming or looking at the item with other filters
never writes them.

**Filter changes live in the address, as differences from the saved filters, one per dimension.**
They use the `/scans` encoding through `lib/finding-view.ts`:

- A dimension that is present replaces the saved value for that dimension.
- A dimension that is missing inherits the saved value.
- An empty value is the explicit "any": it replaces the saved value with no restriction.
- A dimension whose values are all malformed inherits, as if it were missing.

**Nothing is kept per viewer.** A person's filter changes live in their address and nowhere else.

**The effective filters are assembled on the server, in one function.** It takes the item id, the
revision, the filter changes and the widget id, and returns the saved filters, then the changes,
then the widget's override, each replacing the one before for a dimension it sets. Every number,
widget link and Duplicate reads that result.

**A value the viewer cannot use is held back: counted, never named, never dropped, never widened.**
This includes a value named by an address from someone with more Access. The filter keeps
restricting by it, the bar shows how many values are held back, and the count and the rows stay the
ones the viewer's Access allows.

## Considered options

- **Per-viewer saved filters.** Each person keeps their own picks on a shared dashboard. Rejected: a
  hidden second state that two people looking at one dashboard cannot see or compare, a table to
  keep consistent through role changes and deletions, and a link that shows its sender's view
  to no one else.
- **Per-value add and remove in the address.** The address names values to add to or take out of
  the saved set. Rejected: the result depends on what the saved set holds when the link is opened,
  so a saved set that has since changed turns the same link into a different filter, and a removed
  value that is no longer saved has no defined meaning.
- **Filters assembled on the client.** The browser merges the layers and sends one parameter set to
  each widget route. Rejected: the layers can drift between the bar and the widgets, and the
  browser would carry values it must not hold. The server already holds the saved filters and the
  caller's Access.

## Consequences

- A widget route refuses assembled filter parameters. It takes ids and filter changes only.
- A save made against an out-of-date revision is reported as a conflict, never overwritten, and
  the bar and the widgets are kept on one revision.
- An old saved-view link that holds a full copy of the filters still opens as bookmarked: a full
  copy reads as a set of per-dimension differences that replace every saved dimension.
- Duplicate copies the duplicator's effective filters as the copy's saved filters.
- The `/scans` page and the findings explorer keep the symmetry between `scans/page.tsx`
  `searchParams` and the explorer's URL sync, since both read the same encoding.
