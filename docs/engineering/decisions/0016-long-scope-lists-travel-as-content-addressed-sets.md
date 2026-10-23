# ADR 0016: Long Scope lists travel as content-addressed sets

Status: accepted, 2026-10-23 (map #320).

## Context

A Scope filter lives in the address, so a link reproduces the view (ADR 0015). A name-only resource
group converts to every subscription and resource group pair on record for that name, which can be
hundreds of paths. The smallest default address limit on a supported hosting path is nginx's 8 KB
request line, and a list of that size does not fit in it next to the rest of a view's filters.

## Decision

**A `scope=` value over about 1500 characters is written as `scopeset=<hash>`.** The hash is the
sha256 of the sorted, de-duplicated, lower-cased path list. It points to an immutable row in
`scope_sets`, which stores the paths in the casing first written.

**The server validates every path and always computes the hash itself.** A path is accepted only in
a management group, subscription, resource group or Directory shape. A caller sends at most 2000
paths. Unless the caller holds Everything, every path must be a Scope they hold. A hash a client
supplies is never trusted.

**Only the server expands a hash, under the viewer's own Access.** The reference carries no
authority: whoever opens it gets the paths narrowed to what they hold, as for any Scope filter. An
unknown hash is an unresolved Scope filter that matches nothing and says why, rather than an empty
filter that would show everything held.

**Rows are never deleted.** Links, bookmarks and saved views hold their hashes, and a deleted row
would turn each of them into an unresolved filter.

## Alternatives rejected

- **Inline lists.** They break the address budget above.
- **A server-side view store** that keeps a whole view under a short id. It is more state to own and
  share, with its own lifetime and permissions, when only the one long value needs to move.

## Consequences

- A set opens only on the install that made it, while its row exists. On another install, or after
  a restore that lacks the row, the link shows an unresolved Scope filter.
- Identical lists written with different casing or order share one row and one hash.
- The table only grows. A row is small, and a set is written only when a filter is long.

## Builds on

ADR 0015, which defines the Scope filter.
