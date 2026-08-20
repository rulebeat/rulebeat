# Posture: what "X of Y passing" means

This page answers one question: when RuleBeat says "7 of 12 passing", what exactly was counted? It
is the definition the Overall Posture ring, every category headline, the Stat Card, the Category
and Subscription Scorecards and the Trend widget all share. If you are going to put the number in a
weekly report, read this first.

## The definition

Take every **enabled** rule in the scope you are looking at (a category, a dashboard filter, a
subscription). Each rule is in exactly one of three states:

| State | Condition |
|---|---|
| **failing** | The rule has at least one active finding that is not suppressed. |
| **passing** | The rule has zero active, unsuppressed findings **and** its most recent run finished with outcome `success`. |
| **unknown** | Everything else: the rule has never run, or its last run ended `failed`, `capped` or `invalid`, and it has no active findings to show for it. |

Then:

```
posture % = round(passing / (passing + failing + unknown) * 100)
```

Y is the total of all three states. X is passing only. Unknown is never added to passing: a rule
whose query silently errored, or that has not run yet, does not get credit for "no findings". It is
shown separately, as "N unknown" on a Stat Card and "N not yet proven" under the ring. When a scope
contains no enabled rules at all, the figure is empty rather than 0 or 100.

Two consequences worth saying out loud:

- A rule with a finding is failing even if its last run broke. The finding is still there; the
  broken run just could not tell you whether it was fixed.
- Suppressing a rule's only remaining finding moves that rule to passing. That is the point of a
  suppression, and it is why a suppression needs a reason and is audited. See
  [`suppressions.md`](suppressions.md).

## Where each input comes from

- **Active findings** come from the live `findings` table, not from the last scan's blob. A narrow
  scheduled run that only covered three rules does not change what the other rules' findings look
  like.
- **Last run outcome** is written onto each rule every time a scan touches it (`lastRunStatus`). A
  rule outside a scan's target keeps whatever status it had. The Rules tab shows the reason behind
  every non-passing rule as a chip: "not yet run", "query failed", "result capped", "no resource
  id". The outcomes themselves are defined in [`how-it-works.md`](how-it-works.md#one-outcome-per-rule).
- **Suppressions** are joined by fingerprint; an expired suppression no longer counts.

## Applies to changes the reading of a single rule, not the posture

A rule with Applies to turned on shows its findings as "3 of 40 affected" in the Rules tab, where 40
is the size of the population its second query defines. That is a per-rule reading of how bad a
finding count is. The posture figure does not use it: a rule with three findings is one failing
rule whether the population is 40 or 4,000. See
[`authoring-rules.md`](authoring-rules.md#applies-to).

## Why the number moves when your estate did not

People notice this after an upgrade, after enabling rules, or after a run failed, and it is worth
knowing the causes so the movement is not mistaken for drift in Azure.

- **You enabled or disabled rules.** Y changed. Enabling the APRL pack adds rules that have not run
  yet, and every one of them is unknown until its first successful scan, so posture drops and then
  recovers as they run. This is why the pack ships disabled by default.
- **A scan failed or was capped.** The affected rules move from passing to unknown without any
  finding appearing. Run History shows the run as partial coverage; fix the cause and the next
  successful run moves them back.
- **Someone added or removed a suppression.** The finding did not change; its visibility did. The
  audit log records who and why.
- **The formula changed.** RuleBeat once counted a rule with zero findings as passing regardless of
  whether its query had run. It no longer does, and an install upgraded across that change will show
  a lower, more honest number the morning after. The formula is versioned (see Snapshots below) so
  history written under the old definition is not blended with history written under the new one.

## Snapshots and trend

Counts are computed live; trend lines need history. Once a day, after a scan's findings are synced,
RuleBeat writes a `posture_snapshots` row per category, plus one per subscription that has an
active finding, holding that day's passing / failing / unknown counts and the resulting percentage.
Suppressed fingerprints are excluded from the snapshot the same way they are excluded live. Each row
is tagged with the formula version that produced it.

**What a trend can show.** A trend line, the "vs baseline" delta and the Trend widget work for a
category on its own, or a category narrowed to one subscription. That is the granularity the
snapshots are stored at.

**What it cannot show.** With a resource group, tag, severity or rule filter applied, or with two or
more subscriptions selected, the widget reports that a trend is not available rather than drawing
one. Per-subscription pass/fail counts cannot be added together into one honest blended line, since
a rule can pass in one subscription and fail in another on the same day, and a finer filter has no
stored history at all. The widget says exactly this in its empty state.

**Baseline.** "vs baseline" compares today's percentage with the snapshot at or before the start of
your date window, and only blends rows that share the current formula version. Under an older
version the baseline is treated as missing rather than mixed in.

**New versus fixed.** The open-findings delta shown on Stat Cards and the New vs Fixed widget is
computed from live finding timestamps (findings first seen in the window minus findings fixed in the
window), never from subtracting two snapshots. It therefore survives every filter combination and
always agrees with the Scans page.

**Coverage freshness.** The Scan Coverage widget reads the last scan per category and badges it
fresh, recent, stale or never against a threshold you set per widget (one week by default), along
with that run's complete/partial coverage. A category can be fresh and partial at the same time:
the run happened, one of its rules broke.

## Reading a dashboard honestly

- Put the Overall Posture ring next to a Scan Coverage widget. The ring without coverage can look
  fine the morning a schedule stopped firing.
- If the unknown count is not zero, open the Rules tab filtered to that category and read the chips
  before trusting the percentage.
- A percentage across many categories is a percentage of rules, not of resources. Ten tag rules
  passing and one backup rule failing is 91%, even if the backup rule is the one that matters. Use
  severity and category filters, or weight by what you care about in your own reporting.
