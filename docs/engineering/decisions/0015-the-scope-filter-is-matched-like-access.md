# ADR 0015: The Scope filter is matched like Access

Status: accepted, 2026-10-23 (feature "One filter model across Scans, saved views and dashboards", map #320). Builds on [ADR 0010](0010-access-is-roles-at-scopes.md).

## Decision

**One Scope picker replaces the subscription and resource group filters** on dashboards, saved
views, widget overrides and Scans. A pick is a Scope in the sense of ADR 0010: a management group, a
subscription, a resource group or the Directory.

**A pick is matched by the access filter's placement table**, the same one that decides what a
person sees (`lib/db/access-filter.ts`):

- a subscription matches the findings placed in it;
- a resource group matches the findings placed in it, inside its own subscription;
- a management group matches the findings placed at it or at a group beneath it, and the
  subscriptions under it at any depth through the stored hierarchy
  (`management_group_hierarchy`);
- the Directory matches the findings placed in the Directory.

Matching is case-insensitive, as Azure ids are. The result is then **intersected with the viewer's
Access**, so a Scope filter never widens what someone sees. No pick means everything the viewer
holds. Everything is never a pick: it is what holding no filter already means. Matching never reads
a live Azure listing, so a subscription or group Azure no longer lists still matches the findings
recorded against it.

**The one difference from Access.** A pick of a management group the stored tree does not know still
matches the findings placed at that group id. Access expands a group through the tree, so it has
nothing to expand for one the tree lacks. The Scope filter keeps matching because the posture overlap
counts that group's rules there, and the finding count and the posture number under the same filter
must agree.

## Considered options

- **Keeping subscription and resource group as separate filters beside the Scope picker.** Rejected:
  two ways to say the same thing, and a resource group name alone matched across subscriptions,
  which Access never does.
- **Matching picks against a live Azure listing.** Rejected: a Scope Azure no longer lists, or one
  the credential cannot read, would silently drop out of a saved view or a dashboard.

## Consequences

- The cross-subscription resource group name match goes away. A resource group is always a pair with
  its subscription. Stored filters that held a name alone are converted to every pair on record, which
  is why long lists need [ADR 0016](0016-long-scope-lists-travel-as-content-addressed-sets.md).
- A Scope filter and Access are matched by one table, so a change to how a finding is placed changes
  both together.
- A pick outside the viewer's access stays in the filter and is counted, not named, and matches
  nothing.
