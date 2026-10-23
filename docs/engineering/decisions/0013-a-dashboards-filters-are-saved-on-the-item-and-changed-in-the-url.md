# ADR 0013: A dashboard's filters are saved on the item and changed in the URL

Status: accepted, 2026-10-23. Numbered after ADR 0012, which lands with the ownership spec first.

## Context

A dashboard's filter bar saved itself 500 ms after every change. On a shared dashboard that let one
person's narrowing change what everyone else saw. A Viewer, who may not edit the dashboard, had
their picks dropped, so the bar showed a filter the next load did not keep.

Saved views have a second problem. A link to a saved view carries a full copy of its filters, and a
copy cannot carry values the browser never receives: values the viewer's access holds back are not
sent, so the link cannot name them.

## Decision

**Saved filters live on the dashboard row or the saved-view row, and change only through an
explicit save.** The save is checked against the item's revision and written to the audit log. Only
someone allowed to edit the item can make it. Looking at an item, changing the bar or refreshing
the page never writes it.

**Filter changes live in the address, as differences from the saved filters, one dimension at a
time.** They use the Scans encoding from `lib/finding-view.ts`.

- A dimension present in the address replaces the saved value for that dimension.
- A dimension missing from the address inherits the saved value.
- An empty value is the explicit "any": it replaces the saved value with no restriction.
- A value that is all malformed is treated as missing, so it inherits.

**Nothing is kept per viewer.** The address is the only place a change lives, so a change travels
with the link and ends with the tab.

**Effective filters are assembled on the server, in one function.** Its inputs are the item id, the
revision, the filter changes and the widget id. It applies the saved filters, then the filter
changes, then the widget's override, each replacing and never intersecting. Every number, widget
link and Duplicate reads its result.

**Values the viewer cannot use are counted, never named, dropped or widened.** A link from someone
with more access can name values the viewer does not hold. Those values stay in the filter, so the
numbers stay narrow, and the bar says how many are held back without saying what they are.

## Considered options

- **Saved filters kept per viewer.** Rejected: every person would see a different dashboard under
  the same name, a number quoted from it could not be reproduced by the next person, and it
  needs a store that grows with the number of people.
- **Adding and removing single values in the address.** Rejected: a link then means "the saved
  filters, plus this edit", so it reads differently the day the saved filters change. Replacing a
  whole dimension means the same thing against any saved filters.
- **Filters assembled in the browser.** Rejected: the browser would hold the saved layer, the
  address layer and the widget layer, and could send a widget route a filter the viewer's access
  does not allow. Only the server knows what the viewer holds.

## Consequences

- Widget routes refuse assembled filter params. They take the item id, the revision, the filter
  changes and the widget id, and nothing else.
- A save against a revision that has moved on is reported as a conflict and is not written over.
  How the bar shows it is decided in the conflict-notice work.
- Old saved-view links that carry a full copy of the filters still open as they were bookmarked. A
  full copy is a set of changes that names every dimension, so it replaces the whole saved layer.
- Duplicate copies the duplicator's effective filters as the copy's saved filters.
- A layout change, a rename and a change of default never touch saved filters.
