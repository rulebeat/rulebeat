# Posture: what "X of Y passing" means

When RuleBeat says "7 of 12 passing", this is what was counted. The Overall Posture ring, every
category headline, the Stat Card, the Scorecards and the Trend widget share this definition. A
**Trend point** is one stored count for one category at one **Level** (install-wide, one
subscription, or the Directory) on one UTC day; the sections below say how a live number and a
Trend point are compared.

## The formula

The formula is version 3. Count every **enabled Problem rule** that matches the rule-level filters
(category, rule, rule tag) and whose scope overlaps what you are looking at: the Scopes you hold,
narrowed by a subscription or resource group filter when one is set. A rule scoped to nothing
overlaps every subscription, a rule that names subscriptions overlaps those, and a Microsoft Graph
rule overlaps only the Directory. Someone who holds Everything is counted against every rule.
Advisory and Activity rules are never counted.

Each counted rule is in exactly one of three states:

| State | Condition |
|---|---|
| **failing** | At least one active, unsuppressed Problem finding placed inside what you are looking at. With a Severity filter, a finding of a picked severity. |
| **passing** | Not failing, **and** the rule's most recent run finished `success`. |
| **unknown** | Everything else: never run, or the last run ended `failed`, `capped` or `invalid` with no active finding to show for it. |

```
posture % = passing / (passing + failing + unknown), rounded to a whole number
```

Y is all three states, X is passing only, and unknown is never folded into passing. A rule whose
query silently errored does not get credit for "no findings"; it shows separately as "N not yet
proven". Nothing to count reads as a reason, never as 0 or 100.

**The percentage never lies by rounding.** It is never 100 while any counted rule fails or is
unknown, and never 0 while any passes. 239 of 240 passing reads 99, not 100.

**The delta is computed from the unrounded ratios and rounded once.** Subtracting two rounded
percentages can hide a real drop, so the widgets subtract the ratios first. It reads "flat" only
when the two ratios are exactly equal, and a small real change that rounds to 0 shows as 1 pt up or
down. It is labelled "pts vs" with the date it compares against.

**A Severity filter keeps every counted rule in the denominator.** It changes only which findings
fail a rule, so the number reads as "rules with no Critical or High finding", and the failing rules
are the rules on the Scans list for the same filter. A finding counts at its own severity, not the
rule's.

Two consequences worth saying out loud. A rule with a finding is failing even if its last run
broke, because the finding is still there. And suppressing a rule's only remaining finding moves
that rule to passing, which is why a suppression needs a reason and is audited
([`suppressions.md`](suppressions.md)).

**An edited rule keeps its last result until it next runs.** Editing a rule's query or scope does
not turn it unknown. It stays passing or failing on the findings it has, and counts as its new
definition from its next run. The same holds for a severity change: it reaches open findings on the
next scan.

Active findings come from the live findings table rather than the last scan's blob, so a narrow
scheduled run cannot move rules it did not touch. A finding placed at a management group counts
install-wide and for people who hold that group or one above it, not against the subscriptions
under it. The Rules tab shows each rule's last outcome as a chip: "not yet run", "query failed",
"result capped", "no resource id" ([`how-it-works.md`](how-it-works.md#one-outcome-per-rule)).

## Advisory rules are not counted

A rule's **Kind** is Problem or Advisory (a Log Analytics rule is always Activity). An Advisory rule
reports something worth knowing that is not a misconfiguration to fix now, for example a VM size
Azure is retiring. Its findings are kept and tracked like any other, but they are left out of every
number on this page: the posture ring, the rule states above, the Results tiles and severity
breakdown, the dashboard widgets and the Trend points. They
are listed on the Advisories tab instead. The Rules tab still shows how many resources an Advisory rule affects. You choose the kind of a custom rule; a built-in rule's kind is
set by RuleBeat and changes only with a new version of the rule. Switching a rule between Problem
and Advisory moves its existing findings with it and keeps their age and suppressions. As with Activity findings, a stored finding count can step
once on the day a rule is switched, because earlier Trend points were counted the old way and are
not rewritten. Advisory findings are sent only to notification channels that turn on Include advisories
([`notifications.md`](notifications.md)).

## What each widget counts

Every number on a dashboard opens the list it counted on the Scans page. A widget shows the notes
below inside its tile, so they survive printing.

- **Overall Posture ring and category headlines:** the formula above. Note: a rule passes when it
  has no open finding and its most recent run succeeded, and an edit counts from the rule's next
  run. Without Everything: a rule passes here when it has no open finding in your Access and its
  most recent run succeeded, and that run may have covered a different part of the estate.
- **Stat Card:** the metric you pick. "Rules counted" shows the counted rules with "N passing, M
  unknown", and "categories healthy" counts a category only when it has at least one counted rule
  and all of them pass. Carries the same note as the ring on a posture metric.
- **Trend Chart:** the stored Trend points, only where a stored count means the same as the live
  one (see the general trend-filter paragraph below). Notes: where the line's counting changed,
  "Counted differently before" that date; when the window reaches past 365 days, the date the chart
  starts.
- **Top Violating Rules:** the rules with the most open findings, each shown at its highest open
  severity.
- **Category Scorecard:** one row per category with passing, total and open findings. Carries the
  same note as the ring. A category with nothing to count says why.
- **Recent Findings:** the newest active, unsuppressed findings. No note.
- **Severity Breakdown:** open findings by their own severity. No note.
- **Subscription Scorecard:** every subscription RuleBeat knows, plus a row for the Directory if you
  hold it, each graded against the rules whose scope includes it. Notes: a rule counts for every
  subscription or resource group its scope includes, even one with none of the resources it checks;
  a rule whose query picks subscriptions itself counts for all of them; passing uses the rule's
  most recent run anywhere; a finding placed at a management group is counted in the footer, not
  against the subscriptions under it. While a management group cannot be expanded: a rule scoped to
  a management group counts for its subscriptions once RuleBeat has read the management group tree.
  The footer counts findings placed outside any subscription or the Directory.
- **Top Offending Resources:** the resources with the most open findings. No note.
- **Scan Coverage:** last scan time per category, and a category is partial when any enabled rule
  of any kind failed, was capped or was invalid on its last run. A rule that has never run is not
  partial. Last scanned is the newest scan that covered part of what you hold, or, with Everything,
  the newest scan of the category whatever it covered.
- **New vs. Fixed:** the findings on the Scans New and Fixed lists for the window, per UTC day.
  A finding opened and fixed inside the window counts only as fixed.
- **Activity Occurrences:** daily findings from activity rules. Note: when the window reaches past
  180 days, the date the chart starts.
- **Advisories:** open Advisories. They are not counted as problems anywhere else.

Deleted categories are not drawn. A line for a category that no longer exists is left off the
chart, and its stored points are not counted in any baseline.

**A trend is served only where a stored count means the same as the live one.** Trend points are
kept per category for the whole install, each subscription and the Directory. A trend, a baseline
and a delta are therefore shown for a category, the date window, and at most one subscription or the
Directory. With any other filter (a resource group, a tag, a rule, a severity, or two or more
subscriptions) the widget says a trend is not available instead of comparing a filtered number with
an unfiltered stored one. The open-findings delta, which comes from live finding timestamps, keeps
working under every filter.

## When two counts are compared

A live number is compared with a Trend point, and two Trend points with each other, only when the
table below counts their versions as equal. The table is the only place equality is decided
([ADR 0013](../engineering/decisions/0013-trend-points-are-compared-through-one-table.md)). A point
that is unequal is not drawn as part of the same line, and where a line's counting changes it is
marked "Counted differently before" that date.

| Level | Formula versions counted equal | Finding-count versions counted equal |
|---|---|---|
| Install-wide, per category | 2, 3 | 1 |
| Subscription | 3 | 1 |
| Directory | 3 | 1 |

Formula 1 is equal to nothing. Finding-count version 0 means "not recorded" and is equal to
nothing. Formula 2 and 3 count the same install-wide for someone who holds Everything, which is why
they are equal in the first row and not in the others.

## How older trend points were counted

Trend points written before an upgrade are never changed, so some of them were counted by an older
definition. They are not wrong, they are different, and each limit below says how.

- **P1.** Points backfilled on a database from before 0.1.0 count as formula 2. They are removed by
  retention by August 2027.
- **P2.** Before formula 3, subscription points used the install-wide denominator, and a subscription
  with no findings got none. A subscription point written then is not compared with a live number.
- **P3.** Finding counts before finding-count version 1 included Activity findings, and earlier
  still Advisory findings.
- **P4.** A rule scoped to a management group counts for the subscriptions under it as the tree was
  that day. Moving a subscription does not change a past point.
- **P5.** Today's point changes through the day, because every rule, suppression, tree and scan
  change refreshes it. Days are UTC. A suppression that expired while RuleBeat was stopped counts
  from the next start.
- **P7.** A severity change takes effect on the next scan, so a point written before it counts the
  finding at its old severity.
- **Before formula 3, a lag.** A rule or suppression change wrote no point, so a point carried over
  from before can lag behind what the live number says.
- **A missing subscription or Directory point means unchanged.** RuleBeat stores a point for a
  subscription or the Directory only when it differs from the one before, so a quiet day is drawn
  from the last point before it. A subscription that has left your estate is neither carried nor
  drawn.

## Retention

**P6.** Trend points are kept for 365 days, plus each Level's newest point older than that, so a
quiet line still has a point to start from. A deleted category keeps no exception. The Activity
Occurrences chart keeps 180 days. A chart whose window reaches further back says the date it starts.
Retention is the only thing that removes a Trend point. A point dated before today is never edited.

## Why the number moves when your estate did not

Enabling or disabling rules changes Y, and newly enabled rules are unknown until their first
successful scan, so posture dips and recovers. This is why the APRL pack ships disabled. A failed or
capped scan moves rules from passing to unknown with no finding appearing. A suppression changes a
finding's visibility, not the finding. And RuleBeat once counted a rule with zero findings as
passing whether or not its query had run, so an install upgraded across that change shows a lower,
more honest number the next morning.

Switching a shipped [Rule version](rule-versions.md) can also move the number after the next scan,
even when your estate has not changed. The selected definition may return different resources or
use a different severity or category. Matched findings keep their age, history and suppressions;
dropped matches become fixed and new matches open. Switching itself starts no scan and does not
reset findings. Upgrading does not change the version an enabled shipped rule runs, so taking a
new definition is an admin's choice, not a silent consequence of restarting. The one exception is a
rule an earlier release left on a stored definition that differed from the shipped one: it now runs
the shipped version, and the next scan may flag different resources.

## Reading it honestly

Put the Overall Posture ring next to a Scan Coverage widget, because the ring alone looks fine the
morning a schedule stopped firing. If the unknown count is not zero, read the Rules tab chips before
trusting the percentage. Read a Trend point's date before its value: a line that carries a "Counted
differently before" marker is two definitions joined at that date, not one steady measure. And this is
a percentage of rules, not of resources: ten tag rules passing and one backup rule failing is 91%,
even when the backup rule is the one that matters.
