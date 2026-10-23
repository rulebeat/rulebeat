# ADR 0015: The Scope filter is matched like Access

Status: accepted, 2026-10-23 (map #320).

## Context

Dashboards, saved views, widget overrides and the Scans page each narrowed findings by a
subscription filter and a resource group filter. Access narrows findings by Scope, through the
placement table in `lib/db/access-filter.ts`. The two disagreed: a resource group filter matched by
name across every subscription, so one pick could reach a group Access would never have given, and
the posture number and the finding count could be computed from different sets.

## Decision

**One Scope picker replaces the subscription and resource group filters** on dashboards, saved
views, widget overrides and Scans. A pick is a Scope in the sense of ADR 0010: a management group,
a subscription, a resource group or the Directory.

**Picks are matched by the access filter's placement table.** A subscription matches the findings
placed in it. A resource group matches the findings placed in it, inside its own subscription. A
management group matches through the stored hierarchy (`management_group_hierarchy`), plus the
findings placed at that group or at a group below it. The Directory matches the findings placed in
the Directory. Matching is case-insensitive.

**The picks are then intersected with the viewer's Access, so a Scope filter never widens.** No pick
means everything the viewer holds. Everything is never a pick: it is what holding no filter looks
like. Matching never reads a live Azure listing, only the stored hierarchy and the placement the
findings recorded, so a subscription or resource group Azure no longer lists still matches the
findings placed there.

## One difference from Access

A pick of a management group the stored tree does not know still matches the findings placed at
that group id. Access would not match them, since it expands a held group from the stored tree
only. The Scope filter does, because the posture overlap counts the rules scoped to that group
where they have findings, and the finding count and the posture number must agree.

## Consequences

- The cross-subscription resource group name match goes away. A resource group is picked as a pair
  with its subscription, and a name-only value from an old link or a stored filter is converted to
  every pair on record (see ADR 0016 for how a long list of them travels).
- A pick the viewer holds only part of applies as the part they hold. A pick wholly outside their
  Access is counted but not named.
- The Scans page, saved views, dashboards and posture share one definition of "in this Scope", so
  a number on a dashboard and the list its link opens count the same findings.

## Builds on

ADR 0010, which defines Scopes and the placement of a finding.
