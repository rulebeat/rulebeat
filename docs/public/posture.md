# Posture: what "X of Y passing" means

When RuleBeat says "7 of 12 passing", this is what was counted. The Overall Posture ring, every
category headline, the Stat Card, the Scorecards and the Trend widget share this definition.

## The definition

Take every **enabled** rule in the scope you are looking at. Each is in exactly one of three states:

| State | Condition |
|---|---|
| **failing** | At least one active finding that is not suppressed. |
| **passing** | Zero active unsuppressed findings **and** a most recent run that finished `success`. |
| **unknown** | Everything else: never run, or last run ended `failed`, `capped` or `invalid` with no active findings to show for it. |

```
posture % = round(passing / (passing + failing + unknown) * 100)
```

Y is all three states, X is passing only, and unknown is never folded into passing. A rule whose
query silently errored does not get credit for "no findings"; it shows separately as "N not yet
proven". A scope with no enabled rules reads empty rather than 0 or 100.

Two consequences worth saying out loud. A rule with a finding is failing even if its last run broke,
because the finding is still there. And suppressing a rule's only remaining finding moves that rule
to passing, which is why a suppression needs a reason and is audited
([`suppressions.md`](suppressions.md)).

Active findings come from the live findings table rather than the last scan's blob, so a narrow
scheduled run cannot move rules it did not touch. The Rules tab shows each rule's last outcome as a
chip: "not yet run", "query failed", "result capped", "no resource id"
([`how-it-works.md`](how-it-works.md#one-outcome-per-rule)).

## Advisory rules are not counted

A rule's **Kind** is Problem or Advisory (a Log Analytics rule is always Activity). An Advisory rule
reports something worth knowing that is not a misconfiguration to fix now, for example a VM size
Azure is retiring. Its findings are kept and tracked like any other, but they are left out of every
number on this page: the posture ring, the rule states above, the Results tiles and severity
breakdown, the dashboard widgets and the daily snapshots. They
are listed on the Advisories tab instead. The Rules tab still shows how many resources an Advisory rule affects. You choose the kind of a custom rule; a built-in rule's kind is
set by RuleBeat and changes only with a new version of the rule. Switching a rule between Problem
and Advisory moves its existing findings with it and keeps their age and suppressions. As with Activity findings, the open
findings line on the trend chart can step once on the day a rule is switched, because earlier days
were counted the old way and are not rewritten. Advisory findings are sent only to notification channels that turn on Include advisories
([`notifications.md`](notifications.md)).

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

## Snapshots and trend

Counts are live; the trend is worked out from **recorded trend history**. Every time something that
posture depends on changes (a scan syncs, a finding is suppressed, a rule is edited, enabled or
deleted), RuleBeat records the inputs: how many open, unsuppressed findings each rule has in each
place and severity, and the facts about each rule. The trend is computed from those when you open
the dashboard, with today's formula, today's labels and your Access, so it works under every
filter and for every person, and a person who holds one subscription sees a trend of that
subscription. Points are daily and labelled UTC.

What that means when you read it:

- **Past points regroup under today's category.** Move a rule to another category and its earlier
  days move with it. A kind switch between Problem and Advisory steps the line on the day it was
  made, and earlier days are not rewritten.
- **The chart always ends today.** A custom window moves only the comparison, not the end of the
  line. A custom window that ends before today compares its end day, worded `<to> vs <baseline date>`.
- **The baseline is the newest recorded day on or before the window's start.** If nothing was
  recorded that early, the ring and the stat card say there is no baseline rather than comparing
  against nothing.
- **Gaps and no-scan days are marked.** A day RuleBeat was not recording is a gap and the line
  breaks there. A recorded day on which no scan overlapped your filter is marked as such, because
  its numbers are the last ones known, not new ones.
- **Days before recording began are bridged from the daily snapshots** RuleBeat wrote before trend
  history existed (one total per category and one per subscription, tagged with the formula
  version that produced it). The bridge covers two views: Everything with a category filter, and
  one whole subscription. Every other level, such as a resource group, a tag, a severity, a rule, two
  or more subscriptions or a scoped person's Access, says "History at this level starts on <date>"
  and begins on its first recorded day.
- **Clearing a rule's findings keeps them in past trend days.** The record holds what was open on
  each day, so the line does not change, while New vs Fixed loses those events because it is read
  from the finding events, which clearing deletes.
- **Recorded coverage keeps the categories as scanned.** A moved rule's earlier scans do not mark
  its new category as covered on days before the move.

The open-findings delta and the New vs Fixed widget come from live finding timestamps, never from
subtracting two points, so they agree with the Scans page. How long the record is kept is under
[Trend history retention](configure.md#trend-history-retention).

## Reading it honestly

Put the Overall Posture ring next to a Scan Coverage widget, because the ring alone looks fine the
morning a schedule stopped firing. If the unknown count is not zero, read the Rules tab chips before
trusting the percentage. And this is a percentage of rules, not of resources: ten tag rules passing
and one backup rule failing is 91%, even when the backup rule is the one that matters.
