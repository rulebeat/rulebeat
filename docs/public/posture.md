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

## Trend

Counts are live; the trend is worked out from what RuleBeat recorded. Every change to an input of
posture (a scan, a suppression, a rule being enabled, switched or deleted) is recorded the moment it
happens, together with which rules and scopes each scan covered. When you open a trend, RuleBeat
works out each day from those inputs with today's formula, today's labels and your Access. Points
are daily and labelled UTC.

Because the numbers are worked out when you look, the trend serves every filter, including a
resource group, a tag, a severity, a rule, or two or more subscriptions, and it shows only what your
Access lets you see.

- **Past points regroup under today's category.** A rule moved to another category counts in the new
  one on every earlier day too, and a renamed rule reads under its new name.
- **A kind switch steps the line on its day.** Switching a rule between Problem and Advisory changes
  the counts from the day it is switched, and earlier days are not rewritten.
- **The chart always ends today.** A custom window moves only the comparison, not the end of the
  chart. A custom window that ends before today compares its end day, shown as `<to> vs <baseline
  date>`.
- **The baseline is the newest Recorded day on or before the window's start.** A Recorded day is a
  UTC day RuleBeat was recording. "vs baseline" compares the end of the window with that day.
- **Gaps and no-scan days are marked.** A day RuleBeat was not recording is a gap and nothing is
  drawn across it. A recorded day on which no scan overlapped what you are looking at is marked as a
  no-scan day, so a flat line is never mistaken for a clean one.
- **A record that is kept for a year.** The trend record is kept 365 days
  ([`configure.md`](configure.md#trend-history-retention)). It starts on the first day the version
  that records it ran and is never backfilled.

The days before recording began are bridged from the daily `posture_snapshots` totals RuleBeat wrote
until then, and only where they are still comparable (the same formula version). The bridge covers
two views: Everything with a category filter, and one whole subscription. Every other level, such as
a resource group, a tag, a severity, a rule, or several subscriptions, starts on its first recorded
day and says "History at this level starts on `<date>`".

The open-findings delta and the New vs Fixed widget come from live finding timestamps and events
instead, so they always agree with the Scans page. Two consequences follow. Clearing a rule's
findings keeps them in past trend days, while New vs Fixed loses those events. And the recorded
coverage keeps the categories as they were scanned, so a moved rule's earlier scans do not mark its
new category as covered.

If a rolling deploy overlapped, or an older version ran against the same database, past days can
disagree with live until the next daily recount. It corrects the record from the day it runs and
never rewrites an earlier day, and a day with no record is a gap.

## Reading it honestly

Put the Overall Posture ring next to a Scan Coverage widget, because the ring alone looks fine the
morning a schedule stopped firing. If the unknown count is not zero, read the Rules tab chips before
trusting the percentage. And this is a percentage of rules, not of resources: ten tag rules passing
and one backup rule failing is 91%, even when the backup rule is the one that matters.
