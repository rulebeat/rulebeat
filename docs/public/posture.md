# Posture: what "X of Y passing" means

When RuleBeat says "7 of 12 passing", this is what was counted. The Overall Posture ring, every
category headline, the Stat Card, the Scorecards and the Trend widget share this definition.

## The formula

Take every **enabled Problem rule** that looks at what you are looking at: its scope overlaps the
Scopes you hold (narrowed by the subscription or resource group filter, if one is set), and it
matches the rule-level filters (category, rule and rule tag). A Microsoft Graph rule overlaps only
the Directory. Someone who holds Everything is looked at by every rule. Activity and Advisory rules
are never counted. The date window never changes the count.

Each counted rule is in exactly one of three states:

| State | Condition |
|---|---|
| **failing** | At least one active, unsuppressed Problem finding placed inside your Scopes. With a Severity filter set, a finding of a picked severity. |
| **passing** | Not failing **and** its most recent run finished `success`. |
| **unknown** | Everything else: never run, or last run ended `failed`, `capped` or `invalid` with no active findings to show for it. |

```
posture % = passing / (passing + failing + unknown), rounded to a whole number
```

Y is all three states, X is passing only, and unknown is never folded into passing. A rule whose
query silently errored does not get credit for "no findings"; it shows separately as "N not yet
proven". A selection with no counted rules reads empty, with the reason, rather than 0 or 100.

**The clamp.** The percentage is never 100 while any counted rule fails or is unknown, and never 0
while any passes. 239 of 240 passing reads 99%, not 100%.

**The delta.** A change in posture is computed from the unrounded ratios and rounded once, never by
subtracting two rounded percentages. It reads "flat" only when the two ratios are exactly equal, so
a small real change that rounds to zero shows as 1 pt. It is labelled "pts vs <date>" with the date
it compares against.

**A Severity filter keeps every counted rule in the count.** It changes which findings make a rule
fail, so the measure reads "Rules with no Critical or High finding" and the failing rules are exactly
the rules on the Scans list for the same filter.

**An edited rule keeps its last result until it next runs.** Posture does not mark a rule unknown
because its query or scope changed. The edit counts from the rule's next run.

Two consequences worth saying out loud. A rule with a finding is failing even if its last run broke,
because the finding is still there. And suppressing a rule's only remaining finding moves that rule
to passing, which is why a suppression needs a reason and is audited
([`suppressions.md`](suppressions.md)).

Active findings come from the live findings table rather than the last scan's blob, so a narrow
scheduled run cannot move rules it did not touch. The Rules tab shows each rule's last outcome as a
chip: "not yet run", "query failed", "result capped", "no resource id"
([`how-it-works.md`](how-it-works.md#one-outcome-per-rule)).

A finding is counted where it sits ([`access.md`](access.md#where-a-finding-sits)). A finding placed
at a management group counts install-wide and for people who hold that group or one above it, and
never against the subscriptions under it.

## Advisory rules are not counted

A rule's **Kind** is Problem or Advisory (a Log Analytics rule is always Activity). An Advisory rule
reports something worth knowing that is not a misconfiguration to fix now, for example a VM size
Azure is retiring. Its findings are kept and tracked like any other, but they are left out of every
number on this page: the posture ring, the rule states above, the Results tiles and severity
breakdown, the dashboard widgets and the Trend points. They
are listed on the Advisories tab instead. The Rules tab still shows how many resources an Advisory rule affects. You choose the kind of a custom rule; a built-in rule's kind is
set by RuleBeat and changes only with a new version of the rule. Switching a rule between Problem
and Advisory moves its existing findings with it and keeps their age and suppressions. As with Activity findings, the open
findings line on the trend chart can step once on the day a rule is switched, because earlier days
were counted the old way and are not rewritten. Advisory findings are sent only to notification channels that turn on Include advisories
([`notifications.md`](notifications.md)).

## What each widget counts

Each widget states, in plain text inside the tile, the limits that change what its number means.

- **Overall Posture ring, Stat Card and Category Scorecard.** The formula above. The tile says: "A
  rule passes when it has no open finding and its most recent run succeeded. An edit to a rule
  counts from its next run." For someone without Everything the first sentence reads: "A rule passes
  here when it has no open finding in your Access and its most recent run succeeded. That run may
  have covered a different part of the estate."
- **Stat Card.** "Rules counted", with "N passing, M unknown". "Categories healthy" means a
  category with at least one counted rule where every counted rule passes. The change is labelled
  "pts vs <date>".
- **Subscription Scorecard.** One row per known subscription and, if you hold the Directory, a
  Directory row, each graded by the rules whose scope includes it. A rule counts for every
  subscription or resource group its scope includes, even one with none of the resources it checks.
  A rule whose query picks subscriptions itself counts for all of them. Passing uses the rule's most
  recent run anywhere. The footer counts findings placed outside any subscription or the Directory,
  such as at a management group, and opens that list on Scans. While a management group cannot be
  expanded, the tile says a rule scoped to it counts for its subscriptions once RuleBeat has read the
  management group tree. A row for a subscription where you hold only some resource groups is
  counted over those and says "Your resource groups only".
- **Trend Chart.** Trend points, compared only where the table below counts them equal. It says
  where a line's counting changed ("Counted differently before <date>") and, when the window reaches
  past the kept data, where the chart starts.
- **Top Violating Rules.** Open Problem findings per rule, each rule shown at its highest open
  severity.
- **Recent Findings, Top Offending Resources.** Active, unsuppressed Problem findings inside your
  Scopes.
- **Severity Breakdown.** Open Problem findings by each finding's own severity.
- **Scan Coverage.** A category is partial when any enabled rule of any kind has a last run that
  failed, was capped or was invalid; a rule that has never run is not partial. The count opens those
  rules on the Rules tab. It ignores the Scope, tag, rule and Severity filters. "Last scanned" is the
  newest finished scan of the category, whatever it covered, for someone who holds Everything, and the
  newest scan that covered part of what you hold for anyone else.
- **New vs. Fixed.** The Scans New and Fixed lists for the date window, Problem findings only and
  unsuppressed, as per-UTC-day counts. A finding opened and fixed inside the window counts only as
  Fixed. Each bar opens a one-day Scans list holding that number.
- **Activity Occurrences.** Daily findings from Activity rules, kept for 180 days.
- **Advisories.** Open Advisories. The one widget that lists them, because nothing else counts them.

A category that has been deleted is not drawn, even if it still has Trend points.

**Trend filters.** A trend, a baseline and a change are served only where a stored Trend point means
the same as the live number. Any filter other than category, the date window, or a single
subscription or the Directory gets a message that a trend is not available, since a rule can pass in
one subscription and fail in another the same day and the stored points cannot be added into an
honest blended line. Trend points are kept per category for the whole install, each subscription and
the Directory. The open-findings change and New vs. Fixed come from live finding timestamps instead,
so they survive every filter and always agree with the Scans page.

## When two counts are compared

A Trend point records the Formula version and the Finding-count version that produced it. Two points
are compared, drawn as one line or used as a baseline, only when this table counts their versions
equal. It is the only place equality is decided.

| Level | Formula versions counted equal | Finding-count versions counted equal |
|---|---|---|
| Install-wide, per category | 2, 3 | 1 |
| One subscription | 3 | 1 |
| The Directory | 3 | 1 |

Formula 1 equals nothing, and a Finding-count version of 0 ("not recorded") equals nothing. Where a
line's counting changes, the chart marks the day with "Counted differently before <date>" rather than
reading a change of definition as a change in your estate. When a baseline cannot be found for every
category, the change is withheld and names the date it needed and the earliest date it could use,
instead of comparing a different set of rules. A subscription or Directory line starts at its first
formula 3 point.

An upgrade never writes a Trend point dated before the upgrade and never changes an existing one.

## How older trend points were counted

- **Databases from before 0.1.0.** Points already backfilled count as formula 2 and are gone by
  August 2027.
- **Subscription points before formula 3.** They used the install-wide denominator, and a
  subscription with no findings got none. They are not compared with formula 3 points.
- **Finding counts before version 1.** They included Activity findings, and earlier Advisory
  findings.
- **Management groups.** A rule scoped to a management group counts for the subscriptions under it as
  the tree stood that day.
- **Today's point.** It changes through the day as scans finish and rules and suppressions change.
  Days are UTC. A suppression that expires while RuleBeat is stopped counts from the next start.
- **Severity changes.** A change to a rule's severity reaches open findings on the next scan, so
  severity counts follow it from then.
- **Before formula 3.** A rule or suppression change wrote no Trend point, so a carried formula 2
  point can lag behind what you did that day.
- **A missing point.** A missing subscription or Directory point means unchanged since the last
  point. The chart carries the earlier point forward and never reads a gap as zero.

## Retention

Trend points are kept for 365 days, plus each level's newest older point, so a line never loses its
starting value at the edge of the window. When the window reaches past the kept data the chart says
where it starts. Activity occurrences are kept for 180 days. A point dated before today (UTC) is
never changed or deleted apart from this.

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
trusting the percentage. Read a Trend point as what was true on that UTC day under the definition
the table above names, not as a measurement of today. And this is a percentage of rules, not of
resources: ten tag rules passing and one backup rule failing is 91%, even when the backup rule is
the one that matters.
