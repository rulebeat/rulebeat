# Scans and schedules

Everything scan-related lives on the one Scans page, under four tabs: **Results** (current
findings, filterable by category, severity, status and more), **Run History** (every past run and
its coverage), **Rules** (every rule with its enabled state and last outcome), and **Schedules**
(recurring scans). Category is a filter on each tab, not a separate page.

## Manual scans

The Scans page has a Run Scan button that executes a set of rules immediately against your
configured Azure identity and shows results in the Results tab as soon as it finishes. A manual
run never sends a notification, even if it happens to cover categories or rules that a schedule
elsewhere is also watching. Manual and scheduled runs never overlap: an in-progress run holds a
busy flag until it finishes, so a schedule firing mid-scan waits rather than running concurrently
against the same tenant.

## Scheduled scans

Schedules poll every 30 seconds for anything due to run, backed by a hand-written recurrence
engine rather than cron, since cron alone can't express "every 3 weeks" or a pattern anchored to
an arbitrary start date.

### Recurrence

Choose one recurrence type when creating a schedule:

- **Once.** Runs a single time at the date and time you set.
- **Hourly.** Runs every N hours from the start time.
- **Daily.** Runs every N days from the start time.
- **Weekly.** Runs on the days of the week you pick, every N weeks.
- **Monthly.** Runs on a specific day of the month, every N months. If that day doesn't exist in a
  given month (the 31st in February), it runs on the last day of that month instead.

Every recurrence type also takes an end condition: never, on a specific date, or (for the once
type) simply after it runs.

### Targeting

A schedule targets one of four things:

- **All** enabled rules, across every category.
- **Categories** you pick, covering every enabled rule in them.
- **Tags** you pick, covering any enabled rule carrying at least one of them.
- **Specific rules** you pick directly.

Directory rules (checks that read Microsoft Graph instead of Azure Resource Graph, including the
two built-in identity checks) run through a Graph query rather than a KQL query, but they're
ordinary rules otherwise, reachable through any targeting mode, including tags and a specific-rules
list.

### A worked example

A team that wants its security and identity posture refreshed before the working day starts, and
wants to hear about it only when something serious appears, creates one schedule:

| Field | Value |
|---|---|
| Name | Morning security sweep |
| Target | Categories: security, identity |
| Recurrence | Daily, every 1 day, starting tomorrow 06:30 |
| Ends | Never |
| Notify | The "Platform team" Teams channel, minimum severity high |

Every morning at 06:30 the scheduler runs every enabled rule in those two categories. The run
lands in Run History like any manual run would, findings update on the Results tab, and a Teams
message goes out only if the run produced new findings at high severity or above. Other
categories' rules are untouched, and their posture numbers don't move.

### Run history

Every run, manual or scheduled, is recorded in a unified run history with its outcome, how long it
took, and which rules it covered. The Schedules table itself shows each schedule's name, target,
recurrence, next run, and last run, with a status indicator that refreshes automatically.

### What a run records per rule

A scan is not a bare list of findings: every rule in the run ends with exactly one outcome
(success, failed, capped, or invalid), only a successful rule may mark its old findings fixed, and
a run with any non-success outcome is badged **partial** coverage in Run History rather than
folded into the posture number. The outcome model, what each status means, and why it exists are
in [`how-it-works.md`](how-it-works.md#one-outcome-per-rule).

## What "X of Y passing" means

A rule counts as passing only when it currently has zero active findings **and** its most recent
run finished successfully; a rule that hasn't run, or whose last run failed or was capped, is
counted as **unknown** instead, with a chip on the Rules tab saying why. The full definition,
including why the number can move when nothing in your estate changed, is in
[`posture.md`](posture.md).

## Notifications

Channels (Microsoft Teams, Slack, a generic webhook, or email) are a plain address book in
Settings → Notifications; who gets notified, and at what minimum severity, is decided per
schedule, when editing it. Manual runs never notify. Delivery, retries, and the per-channel
delivery history are covered in [`notifications.md`](notifications.md).
