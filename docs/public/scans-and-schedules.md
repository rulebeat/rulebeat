# Scans and schedules

Everything scan-related lives on one Scans page, under four tabs: **Results** (current findings,
filterable by category, severity, status and more), **Run History** (every past run and its
coverage), **Rules** (every rule with its enabled state and last outcome), and **Schedules**.
Category is a filter on each tab, not a separate page.

![The Rules tab, with per-rule enabled toggles, outcome chips and category filters](img/rules-tab.png)

## Manual scans

Run Scan executes a set of rules immediately against your configured Azure identity and shows
results as soon as it finishes. A manual run never notifies, even when it covers rules a schedule
elsewhere is also watching. Manual and scheduled runs never overlap: an in-progress run holds a busy
flag, so a schedule firing mid-scan waits rather than running concurrently against the same tenant.

## Scheduled scans

Schedules poll every 30 seconds for anything due, backed by a hand-written recurrence engine rather
than cron, since cron alone cannot express "every 3 weeks" or a pattern anchored to an arbitrary
start date.

![The Schedules tab showing a daily schedule with its target, recurrence, next run and last run](img/schedules.png)

**Recurrence** is one of once, hourly, daily, weekly (on the days you pick, every N weeks) or
monthly (on a day of the month, every N months, falling back to the last day where that day does not
exist). Every type takes an end condition: never, or on a date.

**Targeting** is one of four: all enabled rules, the categories you pick, the tags you pick (any
enabled rule carrying at least one), or specific rules. Directory rules are reachable through every
targeting mode, tags and specific-rule lists included.

Notification channels are assigned per schedule, along with the minimum severity and optional
category and subscription scope for each. See [`notifications.md`](notifications.md).

A due schedule is claimed before its scan starts: one conditional database update moves its next
run forward, so two RuleBeat containers overlapping during a rolling deploy cannot both run it.
While a scan runs, its row in Run History carries a heartbeat refreshed every 30 seconds. A run
whose heartbeat is more than five minutes old is marked as not completed at the next start or
scheduler tick, with the findings it had already recorded kept and its notifications, if any were
due, sent then. A run interrupted that way is not re-run at boot; the schedule waits for its next
occurrence.

## Filter, columns and sort on the Results and Advisories tabs

Both tabs filter, sort and page the same way. Besides the built-in filters, in the By resource view
the Columns menu lists every field the rules' queries returned. Pick a field to show it as a column,
then use its header to sort or to filter by its values. The Add filter button in the toolbar
filters by any built-in field or any returned field: pick the field, then tick values among those
the current findings hold. Every active filter, from the toolbar, a column header or Add filter,
shows as a chip, and the chip's cross removes that value. A filter is a set of accepted values; a
finding with several returned rows is kept when at least one row passes every returned-field filter,
and only those rows are shown and exported. Empty values sort last in both directions, and numbers
sort as numbers. The whole view is in the address, so a link reproduces it: `cols` for the columns,
`sort` as `field:asc` or `field:desc` (a returned field is written `row.<name>`), `rf` for a
returned-field filter (`rf=feature=Retiring|Preview` keeps rows whose value is one of those), `f`
for the other built-in fields (`f=resourceName=vm1`, `f=firstSeen=2026-10-01`), and `page`. In a
value, write `\,`, `\|`, `\=` and `\\` for a comma, bar, equals sign and backslash; anything else,
including `%` and spaces, is written as it is. A returned field no finding has gives an empty column
and a filter that keeps nothing.

## Disable, clear findings, or suppress

Three controls make findings go away, and they mean different things.

- **Disable the rule**, with the toggle on the Rules tab. The rule stops being scanned. Its
  findings are left exactly as they were, still listed and still counted, because no scan looks at
  them again and only a rule that ran can mark its own findings fixed. Use it for a rule that is
  right but not wanted right now. To disable or enable many rules at once, select them with the
  checkboxes on the Rules tab (editor and admin), or use the checkbox above the list to select
  every rule the current filters show, then pick the action. Each action changes only the selected
  rules it applies to, and a rule hidden by the filters drops out of the selection.
- **Clear findings**, next to the affected count on the Rules tab (editor and admin). Deletes
  every finding the rule has ever produced, active and fixed, together with their history, and
  keeps the rule. Use it when the rule turned out to be wrong: the findings were never real, so
  marking them fixed would record remediation nobody did. Built-in rules can have their findings
  cleared even though they cannot be deleted. If the rule is still enabled, the next scan that runs
  it recreates whatever still matches and notifies about each one as new, so disable the rule
  first unless a clean baseline is what you want. Suppressions are kept, so a finding that comes
  back is still suppressed. Past runs in Run History and past days on the trend charts keep their
  original counts. The action is written to the audit log with the number of findings removed.
- **Suppress a finding** ([`suppressions.md`](suppressions.md)) records that one finding is real
  but accepted. It hides that finding from the figures without deleting anything.

## Run history

Every run, manual or scheduled, is recorded with its outcome, duration and which rules it covered.
The Schedules table shows each schedule's name, target, recurrence, next run and last run, with a
status indicator that refreshes automatically.

![The Run History tab listing scheduled runs with their duration, rule counts and findings](img/run-history.png)

A scan is not a bare list of findings: every rule in a run ends with exactly one outcome, only a
successful rule may mark its old findings fixed, and a run with any non-success outcome is badged
**partial** coverage rather than folded into the posture number. The outcome model is in
[`how-it-works.md`](how-it-works.md#one-outcome-per-rule), and what "X of Y passing" counts is in
[`posture.md`](posture.md).
