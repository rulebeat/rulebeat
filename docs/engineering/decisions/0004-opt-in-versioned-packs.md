# ADR 0004: Shipped rules are versioned, and a running rule changes only when an admin picks a version

Status: accepted, 2026-10-06.

## Decision

Every shipped rule belongs to a pack. RuleBeat Core is RuleBeat's own pack and APRL is the first
third-party pack. All packs follow one model, and adding a pack is still dropping in files.

Each shipped rule carries a rule version. Core rules use semver starting at 1.0.0, set by us: major
when what the rule detects changes, minor when the query changes but its meaning does not, patch
for text only. A third-party rule uses its upstream's version. When upstream has none, as with
APRL (no releases, no tags), the version is the upstream commit date of the pinned commit at the
sync where the rule's definition last changed, and the commit itself is kept only as a detail. The
date RuleBeat ran the sync is never a version. RuleBeat never invents a version for a third-party
rule.

An upgrade never changes what an enabled rule runs. A newer shipped version is added to the rule's
version selector beside the one in use, marked as new there and on the rule's row in the Library
list, which can be filtered by it. Nothing else announces it: no update queue, no notification. An
admin switches a rule by picking a version in the selector, one rule at a time, after seeing a
before/after of what changes; the switch is audited. This holds for every change, text-only ones
included. Disabled rules move to the newest version on upgrade, since nothing they produce can
change. A rule its pack stops shipping becomes a retired rule: it keeps running its last version,
is marked retired in the selector and the list, and is disabled only if someone disables it.

The image ships only the newest definitions. Each install records every version it has seen, which
is what makes going back possible without shipping the full history.

Switching versions behaves like any rule edit: matching findings keep their age, history and
suppressions, findings the new version no longer returns are fixed, and new ones are new.

## Why

Most people run shipped rules as they are rather than duplicating them. A definition that changes
on upgrade resolves findings that were never fixed and opens new ones, and posture moves with
nothing to explain why. Before this decision Core rules were refreshed silently on every start and
pack rules were never refreshed at all, so neither source was right.

## Considered options

- **Refresh shipped rules on upgrade.** Rejected for the reason above.
- **A separate "changed by rule update" label on findings.** Rejected as confusing. A version switch
  is a rule edit like any other.
- **An update flow** (an "Updates available" queue, a notification digest, accept or stay on a
  version, bulk accept per pack). Rejected as more machinery than the choice needs. A version
  selector with a "new" marker carries the same decision.
- **Ship every historical version in the image.** Rejected. Pack files would grow forever to cover
  a case that local history already covers: going back after an update that turned out badly.
- **A counter we assign to APRL rules, or the commit hash as the label.** Rejected. The first
  invents a version and the second is unreadable. A date sorts and still comes from upstream.

## Consequences

- Custom rules have no version for now. Editing one is saved immediately and recorded in the audit
  log. Versioning custom rules is planned as a separate change, so the version history stored per
  rule must not assume a rule belongs to a pack.
- The two Identity built-ins can no longer have their Graph query tuned in place; tuning means
  duplicating, as for every other shipped rule. On upgrade an install that already tuned one has
  that rule converted in place to a custom rule, so it keeps its id, findings and query.
