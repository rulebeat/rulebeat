# ADR 0013: Trend points are compared through one table, and an upgrade never rewrites history

Status: accepted, 2026-10-28 (issue #440, map #320). Continues ADR 0005's "past snapshots are not
rewritten" and leaves ADR 0008's sequence as it was.

## Decision

**An upgrade may add columns whose default means "not recorded", write new trend points from now
on, and change how readers compare points. It never changes a point it did not write today.** A
trend point is one stored count for one category at one Level on one UTC day, with the Formula
version and the Finding-count version that produced it. What an old point means is decided by the
reader, never by editing the point.

**One table decides which versions are equal.** It is a client-safe module with no database
imports, and the only place equality is decided. No reader, writer or widget compares two version
numbers itself.

| Level | Formula versions counted equal | Finding-count versions counted equal |
|---|---|---|
| Install-wide, per category | 2 and 3 | 1 |
| One subscription | 3 | 1 |
| The Directory | 3 | 1 |

Formula 1 equals nothing. Finding-count version 0 ("not recorded") equals nothing, so a point
written before the column existed is never compared on its finding counts. Install-wide numbers do
not change between formula 2 and 3 for someone who holds Everything, which is why those two count
as equal there; a subscription point written under formula 2 used the install-wide denominator, so
it is refused. A future version bump is a one-row edit to the table, with the matching row in
`docs/public/posture.md` ("When two counts are compared"), which a unit test keeps in step.

**Points dated before today (UTC) are never updated and never deleted, apart from retention.**
Retention keeps 365 days, plus each (category, Level)'s newest point older than that cutoff, so a
line that goes quiet still has a point to start from. Nothing ever inserts a point dated before
today, including the one-time backfill, whose past-dated loop is removed. Today's point is last
write wins: every refresh overwrites it.

**The writer writes only the UTC day of the `now` it is given.** Production callers pass none, so
the day is the current UTC day. A test, or the Demo replaying its simulated days, passes its own.

**The Directory is a Level, keyed by `DIRECTORY_SUBSCRIPTION`.** Subscription Levels are keyed and
compared in lower case on both sides, because Azure returns the same subscription id in more than
one case and a case-sensitive key would split one Level in two.

**A missing subscription or Directory point means "unchanged since the last point".** The writer
stores a subscription or Directory point only when today's already exists or when it differs from
the newest earlier point at that Level. Readers carry the last point forward over quiet days and
never store the carried copy.

**The trend allow-list stays narrow until ADR 0014.** A trend, baseline and delta are served only
for a category, the date window, and at most one subscription or the Directory. Any other filter
gets no trend, so a filtered live number is never compared with an unfiltered stored point. ADR
0014 widens the list by bridging through this table.

**Exemptions.** The Demo generator and Demo Reset's `shiftDemoHistory` write and move dated points
on purpose, because a Demo's history is generated and its dates shift at every Reset. Neither is a
real install's history, and both write at formula 3 and finding-count version 1.

**ADR 0008's sequence still holds.** The startup backfill still sets its marker, so blob emptying
runs when it did. Only what the backfill writes changes: today's refresh in place of a loop over
past days.

**`posture_snapshots` keeps being written as defined here.** The table keeps its name. Every point
is written at formula 3 and finding-count version 1, and a point from an earlier release keeps the
versions it had, with finding-count version 0.

## Considered options

- **Guess what a backfilled row is by its shape.** Rejected. A backfilled row and a real one can
  carry the same counts, and a wrong guess changes a number someone has already read. The upgrade
  stops writing them, and the reader's table says what the old ones count as.
- **A global version bump.** Rejected. Raising one number would make every older point unequal
  everywhere, so an Admin with a year of install-wide history would lose the whole line on the day
  of the upgrade, although install-wide counts did not change.
- **Option B severity: narrow the denominator by each rule's severity.** Rejected. A rule's
  severity is its current one, and a stored point cannot be recomputed under it. The denominator
  stays the same and a Severity filter changes only which findings fail a rule.
- **Treat edited rules as unknown until they next run.** Rejected. It would move a rule out of
  passing on every edit, so the number would dip for a change that fixed nothing and broke
  nothing. The limit is stated on the widget instead: an edit counts from the rule's next run.
- **A partial baseline blend.** Rejected. When some categories have no comparable point, building
  the baseline from the rest compares two different sets of rules. The delta is withheld, and the
  message names both dates.

## Consequences

- The newest older point of every (category, Level) survives retention, so a subscription that
  has left the estate keeps one old point per category until its category is deleted. This is an
  accepted cost, bounded by the number of subscriptions that ever had a point times the number of
  categories, and one row each.
- A pre-0.1.0 database keeps its backfilled points as formula 2. Install-wide they read as equal
  to formula 3 until retention removes them; at a subscription Level they are refused.
- Points written before this release carry finding-count version 0 and never equal version 1, so
  nothing drawn today depends on their finding counts. The version is stored for ADR 0014.
- Every posture input refreshes today's points (a scan sync, a rule or suppression change, a
  management group tree change, a suppression expiry, a start), each awaited by its caller, so the
  refresh has to stay fast. This spec's threshold is that one refresh finishes in under 1 second.
  It is not an existing rule of the repository. The refresh-on-every-input ticket measures it and
  fills in the table below, on the workload of 2,000 subscriptions, 30 categories and 50,000
  findings.

Measured on the benchmark harness, with the machine and the backend named:

| Machine | Backend | Refresh of today's points | Threshold |
| --- | --- | --- | --- |
| to be filled in | SQLite | to be filled in | under 1 s |
| to be filled in | Postgres | to be filled in | under 1 s |
