# ADR 0016: Long Scope lists travel as content-addressed sets

Status: accepted, 2026-10-23 (feature "One filter model across Scans, saved views and dashboards", map #320). Builds on [ADR 0015](0015-the-scope-filter-is-matched-like-access.md).

## Context

The Scope filter lives in the address, so a link reproduces what someone sees. A resource group
named without its subscription converts to every pair on record, which can be hundreds of paths. The
smallest default address limit on a supported hosting path is nginx's 8 KB request line, and a
filter that breaks the link when it grows is a filter nobody can share.

## Decision

**A `scope=` value over about 1500 characters is written as `scopeset=<hash>`** instead. The hash is
the sha256 of the sorted, de-duplicated, lower-cased path list. It points to an immutable row in
`scope_sets`, which stores the paths in the casing they were first written in.

**The server validates every path and always computes the hash itself.** A caller never supplies one.
A path must have the shape of a management group, a subscription, a resource group or the Directory,
a caller sends at most 2000, and each must be a Scope the caller holds, unless the caller holds
Everything.

**Only the server expands a hash, and it does so under the viewer's own Access.** A hash is a
reference, not a grant: opening someone else's link shows only the part of the list the viewer holds,
and the Scope filter is narrowed to it as in ADR 0015.

**An unknown hash is an unresolved Scope filter.** It matches nothing and says why, instead of
quietly showing everything.

**Rows are never deleted.** Links, bookmarks and saved views hold their hashes, and a row is small.

## Considered options

- **Inline lists.** Rejected: they break the address budget above.
- **A server-side view store** holding the whole filter under a short id. Rejected: it is more state
  to own, to share and to migrate, for a problem that only the Scope list has.

## Consequences

- A reference opens only on the install that made it, and only while its row exists. Copied to
  another install, or after a restore from an older backup, it shows as an unresolved Scope filter.
- Writing a set is idempotent: the same list always gives the same hash and the same row.
