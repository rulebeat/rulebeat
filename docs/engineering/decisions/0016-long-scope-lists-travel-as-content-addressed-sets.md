# ADR 0016: Long Scope lists travel as content-addressed sets

Status: accepted, 2026-10-28 (map #320, spec "One filter model across Scans, saved views and
dashboards"). Builds on [ADR 0015](0015-the-scope-filter-is-matched-like-access.md).

## Context

A Scope filter lives in the address so a link reproduces a view. A name-only resource group, once
converted, becomes every subscription and resource group pair on record, which can be hundreds of
paths. The smallest default address limit on a supported hosting path is nginx's 8 KB request
line, and a link over it fails before RuleBeat sees it.

## Decision

**A `scope=` value over about 1500 characters is written as `scopeset=<hash>` instead.** The hash
is the sha256 of the sorted, de-duplicated, lower-cased path list. It points to an immutable row in
`scope_sets` that stores the paths in their first-written casing.

**The server validates every path and always computes the hash itself.**

- Only the shapes of a management group, a subscription, a resource group or the Directory are
  accepted.
- A caller may send at most 2000 paths.
- Only Scopes the caller holds are accepted, unless they hold Everything.
- A hash a client sends is never trusted: the server hashes the validated list and answers with
  its own value.

**Only the server expands a hash, and it does so under the viewer's own Access.** A link carries no
paths, and opening it shows someone only the part of the list they hold, as ADR 0015 does for an
inline list.

**An unknown hash is an unresolved Scope filter.** It matches nothing and says why: the reference
comes from another install, or its row is gone. It is never read as no pick, which would widen the
view to everything held.

**Rows are never deleted.** Links and bookmarks hold their hashes, and a row is small. Because the
row is content-addressed, writing the same list twice is the same row.

## Alternatives rejected

- **Inline lists.** They break the address budget on the hosting paths RuleBeat supports, and the
  failure is silent: the link simply does not load.
- **A server-side view store** (a stored view with an id that the address names). It adds state to
  own, and to share: who may open it, who may change it, and when it expires. A content-addressed
  row has none of that, since nobody edits it.

## Consequences

- A `scopeset=` link opens only on the install that made it, and only while its row exists.
- Short lists stay readable in the address, and old `subscription=` and `rg=` links still open as
  Scope picks.
- The `scope_sets` table grows without bound in principle. Each row is only its path list, and a
  caller is limited to 2000 paths per row.
