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
([`how-it-works.md`](how-it-works.md#one-outcome-per-rule)). Applies to does not enter the formula:
a rule with three findings is one failing rule whether its population is 40 or 4,000
([`authoring-rules.md`](authoring-rules.md#applies-to)).

## Why the number moves when your estate did not

Enabling or disabling rules changes Y, and newly enabled rules are unknown until their first
successful scan, so posture dips and recovers. This is why the APRL pack ships disabled. A failed or
capped scan moves rules from passing to unknown with no finding appearing. A suppression changes a
finding's visibility, not the finding. And RuleBeat once counted a rule with zero findings as
passing whether or not its query had run, so an install upgraded across that change shows a lower,
more honest number the next morning.

## Snapshots and trend

Counts are live; trend lines need history. Once a day, after a scan's findings are synced, RuleBeat
writes a `posture_snapshots` row per category, plus one per subscription holding an active finding,
with that day's passing / failing / unknown counts and the percentage, tagged with the formula
version that produced it. Suppressed fingerprints are excluded there as they are live.

So a trend works for a category, or a category narrowed to one subscription. Under a resource group,
tag, severity or rule filter, or with two or more subscriptions selected, the widget reports that a
trend is not available rather than drawing one: per-subscription counts cannot be added into an
honest blended line, since a rule can pass in one subscription and fail in another the same day.
"vs baseline" compares today against the snapshot at or before the start of your window and only
blends rows sharing the current formula version. The open-findings delta and the New vs Fixed widget
come from live finding timestamps instead, never from subtracting two snapshots, so they survive
every filter and always agree with the Scans page.

## Reading it honestly

Put the Overall Posture ring next to a Scan Coverage widget, because the ring alone looks fine the
morning a schedule stopped firing. If the unknown count is not zero, read the Rules tab chips before
trusting the percentage. And this is a percentage of rules, not of resources: ten tag rules passing
and one backup rule failing is 91%, even when the backup rule is the one that matters.
