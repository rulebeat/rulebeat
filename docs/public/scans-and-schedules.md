# Scans and schedules

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

### Run history

Every run, manual or scheduled, is recorded in a unified run history with its outcome, how long it
took, and which rules it covered. The Schedules table itself shows each schedule's name, target,
recurrence, next run, and last run, with a status indicator that refreshes automatically.

### What a run records per rule

A scan is not a bare list of findings. Every rule in the run ends with exactly one outcome:
**success** (the query ran to completion), **failed** (it threw), **capped** (it came back
truncated, or the KQL has a top-level `take`/`limit`, so its findings are real but not exhaustive),
or **invalid** (its rows carried no resource id). Only a `success` outcome is allowed to mark a
rule's previously-active findings as fixed when they do not reappear; a failed or capped rule keeps
its old findings as they were rather than quietly "fixing" them. A run with any non-success outcome
is badged **partial** coverage in Run History, and the coverage-freshness dashboard widget shows the
same per category.

## What "X of Y passing" means

Every category's headline number, and the Overall Posture ring, count a rule as passing only when
two things are both true: it currently has zero active findings, and its most recent run finished
successfully. A rule that has not run yet, or whose last run failed, was capped, or returned rows
with no resource id, is counted separately as **unknown** rather than folded into passing. The Rules
tab shows why per rule, with a chip reading "not yet run," "query failed," "result capped," or "no
resource id." The full definition, including why the number can move when nothing in your estate
changed and what the trend widgets can and cannot show, is in [`posture.md`](posture.md).

## Notifications

Notification channels (Microsoft Teams, Slack, a generic webhook, or email) are configured once
from Settings → Notifications as a plain address book: a name, a type, and a destination. Who gets
notified, and at what severity, is then decided per schedule: when editing a schedule, choose
which channels should notify for it and the minimum severity that should trigger one.

A transient delivery failure (a network error, a timeout, an HTTP 429, or a 5xx) retries up to
three total attempts with backoff. A 4xx response never retries, since retrying a rejected
request just repeats the same rejection. Every attempt is recorded in a per-channel delivery
history, viewable from Settings → Notifications, so a missed notification is something you can
actually diagnose rather than something you have to take on faith.

Manual runs never notify. Only scheduled runs do, and only through the channels that specific
schedule has assigned.
