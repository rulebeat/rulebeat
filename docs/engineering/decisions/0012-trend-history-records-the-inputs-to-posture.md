# ADR 0012: Trend history records the inputs to posture, not posture

Status: accepted, 2026-10-23 (map #320).

## Context

The trend was drawn from `posture_snapshots`: one total per category and one per subscription, written
once a day. A total cannot be re-cut. It answers no filter finer than the grain it was written at, it
cannot be limited to what one person may see, and a rule that changes category or kind leaves
earlier totals counted the old way. Under a resource group, tag, severity or rule filter, with two or
more subscriptions, or for a person whose Access is only resource groups, the widget had no trend to
show ([ADR 0010](0010-access-is-roles-at-scopes.md), [ADR 0011](0011-the-library-is-written-on-everything.md)).

## Decision

**Trend history keeps the inputs to posture as they changed, and a trend is computed on read.** Three
kinds of record, written as change rows (a value is written only when it differs from the key's newest
row):

- **Cells.** For each rule and each place, keyed the way `lib/db/access-filter.ts` matches a finding
  to a Scope, and each severity: how many open, unsuppressed Problem findings there are.
- **Rule facts.** For each rule: enabled, kind, scope, running version and last-run status, plus a
  deleted rule's last labels (name and category) so its past days still read.
- **Recorded day markers.** One per UTC day RuleBeat was recording, holding the covered scope of the
  scans that finished that day.

A trend reads those rows and works out each day with **today's formula, today's labels (a rule's name
and category), today's management group tree and the viewer's Access**. Only cells inside the viewer's
Access are summed, what each rule checked is taken as recorded, and management groups are expanded by
today's tree. Points are daily and labelled UTC. A day with no Recorded day marker is a gap. A
Recorded day on which no scan overlapped the point's scope is a no-scan day and is marked as one.
The baseline is the newest Recorded day on or before the window's start.

**Nothing is backfilled or rewritten.** Recording starts on the first start of the version that ships
it. `posture_snapshots` is kept, is still written unchanged, and is read only to bridge the days
before recording began. The bridge covers the levels it already holds that map onto a trend: Everything
with a category filter, and one whole subscription. Every other level says "History at this level
starts on `<date>`". The bridge joins the record only where the formula versions are equal, through
the version-equality table.

**The write contract.**

- **One module writes the record.** Every posture input (a scan sync, a suppression, an expiry, a
  placement change, a rule write, a rekey) writes through the trend-record module, in the same
  transaction as the change it records. A writer allowlist test fails any other writer.
- **The record lock is taken last.** On Postgres the touched keys are recounted under one advisory
  lock, taken after any name lock and held only for the reads, record inserts and `trend_state`
  updates. On SQLite the writer lock already serialises them.
- **A failed write fails the action.** A scan whose record write fails fails the scan, and a
  suppression whose record write fails is not saved. There is no queue and no later repair of the
  action itself.
- **No write is dated before its key's newest row.** A write that would be (a clock step back, an
  overlap with an older version) is dated at that row, and a per-key sequence number breaks the tie,
  so a key's rows always read in the order they were written.
- A deleted rule writes its cells to 0, so its findings leave past days from the day of the delete
  and not earlier.

**Retention.** The trend record is trimmed to 365 days. Per key, the newest row at or before the
cutoff is kept, because it says what was true when the window opens, and so is the newest marker
older than the cutoff. Finding events (created, reactivated, resolved, occurred) are kept 365 days;
`row_added` and `row_removed` are kept 180.

**Record versioning.** A change to what the record stores (a new cell dimension, a new rule fact) is
a `record_version` bump. A day recorded under another version is marked on earlier days, and
the version-equality table says which versions may be added or bridged. A day is never recomputed
to the new shape. The first days of a version read as a stated step, not as a silent mix.

**A rule-id rename is the one written exception to "never rewritten".** Findings are keyed on
`sha256(ruleId::resourceId)` and everything derived from an id has to be rewritten with it
([data conventions](../conventions/data.md)). A future rename of a rule id therefore rewrites the
rule's rows in the trend tables with the same pass that rewrites its findings, and nothing else in
the record is ever edited.

**Moving a rule to another category now moves its findings at once.** The findings keep their age and
suppressions and appear under the new category on the next read, not on the rule's next scan. Past trend points regroup under today's category, because the
category is a label read today. The recorded coverage of earlier scans keeps the categories as they
were scanned, so a moved rule's earlier scans do not mark its new category as covered.

## Considered options

- **A snapshot per filter combination, or a finer grain of snapshot.** Rejected: the combinations of
  category, subscription, resource group, tag, severity, rule and Access cannot be listed in advance,
  and each new filter would need a backfill that cannot exist.
- **Rebuilding the past from finding events.** Rejected: events say when a finding appeared and
  went, not when a rule was enabled, switched kind, changed scope or version, or when a suppression
  hid a finding, and they are kept for a shorter time.
- **Caching a computed trend.** Rejected: a cache key would have to carry the viewer's Access, the
  formula, the labels and the tree, so it would mostly miss, and a stale entry would show a number
  that Scans no longer agrees with.
- **Writing the record after the action commits.** Rejected: a crash between the two leaves a past
  day that silently disagrees with Scans. Failing the action is the cheaper failure.

## Consequences

- Any filter and any Access gets a trend, and a trend always agrees with live posture because both
  are the same formula over the same inputs.
- **Limit 1: read consistency holds only from the retention cutoff onward.** Before it the record is
  trimmed to each key's newest row, so a window that opens earlier reads the cutoff's state for the
  days it has no rows for.
- **Limit 2: today's live point can be newer than the window rows.** Today's point is worked out
  from live findings, while the window's rows are as recorded at the last write, so the last two
  points can differ until the next write.
- **Limit 3: past days can disagree after an overlap or an older version.** During the rolling-deploy
  overlap [`install.md`](../../public/install.md) allows, or after an older version ran against the
  database, a posture input can change without being recorded. Past days can then disagree with
  live until the next daily recount, which corrects the record dated when it runs and never rewrites
  an earlier day. A day with no marker reads as a gap.
- **The budgets are uncontended medians.** A 365-day read and the record write on a full sync each
  take under 1 second, and a suppression under 100 ms, on a large estate and on both backends, with
  no cache. They are medians measured with nothing else running, not guarantees under load.
- **On SQLite a suppression during a sync waits for the whole sync.** There is one writer, and the
  sync holds it for its transaction. Postgres waits only for the record lock.
- **With every scheduler off, or a Demo with Reset off, idle days read as gaps and retention waits.**
  Recording days and trimming both ride on the daily job, so an install that never runs one draws
  gaps and keeps the whole record until one runs.
- Switching backends starts a new record. There is no data migration between backends.
- A person whose Access is only resource groups now has a trend, which supersedes the last
  consequence of ADR 0011.
