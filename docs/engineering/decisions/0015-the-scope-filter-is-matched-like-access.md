# ADR 0015: The Scope filter is matched like Access

Status: accepted, 2026-10-28 (map #320, spec "One filter model across Scans, saved views and
dashboards"). Builds on [ADR 0010](0010-access-is-roles-at-scopes.md).

## Context

Dashboards, saved views, widget overrides and Scans each filtered by subscription and by resource
group, as two separate lists. A resource group was a bare name, so the same name in two
subscriptions matched in both, and the match did not follow the rules that decide what a person
sees under Access. A filter and a person's Access could disagree about whether one finding was in
scope.

## Decision

**One Scope picker replaces the subscription and resource group filters** on dashboards, saved
views, widget overrides and Scans. The values it holds are Scopes: a management group, a
subscription, a resource group inside its subscription, or the Directory.

**A pick is matched by the access filter's placement table** (`lib/db/access-filter.ts`), the same
one that decides what a person sees:

- a subscription matches the findings placed in it;
- a resource group matches the findings placed in it, inside its own subscription only;
- a management group matches the findings placed at it or at a group beneath it, and the
  subscriptions under it at any depth, read through the stored hierarchy
  (`management_group_hierarchy`);
- the Directory matches the findings placed in the Directory.

Matching is case-insensitive, as Azure ids are.

**The matched picks are then intersected with the viewer's Access, so a Scope filter never
widens.** No pick means everything the viewer holds. Everything is never a pick: it is the absence
of one. A pick the viewer holds only in part applies as the part they hold.

**Matching never reads a live Azure listing.** It uses the findings' recorded placement and the
stored hierarchy, so a filter gives the same answer when Azure is unreachable, and a Scope Azure no
longer lists still matches what was recorded under it.

## The one difference from Access

A pick of a management group that the stored tree does not know still matches findings placed at
that group id, although Access reads a management group only through the stored tree. The reason is
posture: its overlap counts a rule scoped to that group wherever the rule has findings (see
[`posture.md`](../../public/posture.md#under-filters)). If the finding count ignored the group while
posture counted its rules, the two numbers on one dashboard would disagree, so the filter matches
findings placed at the group id and the two agree.

## Consequences

- The cross-subscription resource group name match goes away. A resource group is picked together
  with its subscription, and a name-only value from an old filter is converted to every pair on
  record (see [ADR 0016](0016-long-scope-lists-travel-as-content-addressed-sets.md) for how that
  list travels).
- A filter cannot show a person anything their Access hides, so a shared dashboard or saved view
  needs no separate check at the point of sharing.
- The Scope picker lists only the Scopes the viewer holds. A pick they do not hold is counted, not
  named, and a pick Azure no longer lists stays visible and is marked.
- Count and posture share one definition of "inside the pick", so a widget's number and the list it
  links to agree.
