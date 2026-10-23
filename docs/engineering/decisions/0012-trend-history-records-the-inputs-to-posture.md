# ADR 0012: Trend history records the inputs to posture, not posture

Status: accepted, 2026-10-23 (map #320). Rests on formula v3 and the filter model. ADR 0008's
snapshots and the findings lifecycle stand.

## Decision

**RuleBeat records what posture is made of, and works the trend out when it is read.** Three kinds of
record make up Trend history, each an append-only list of changes:

- **Cells.** One row each time the count of a cell changes. A cell is a rule, a place (keyed the way
  `access-filter.ts` matches a finding to a Scope) and a severity, and its count is the open,
  unsuppressed findings of a Problem rule there.
- **Rule facts.** One row each time something about a rule changes that posture depends on: whether
  it is enabled, its kind, its scope, the version it runs, the status of its last run, and, for a
  deleted rule, the labels it had last.
- **Recorded day markers.** One a day, holding the covered scope of the scans that finished that day,
  so a day with scans that overlap the viewer's filter is told apart from a day with none.

A trend is computed on read with today's formula, today's labels, what each rule checked as
recorded, management groups expanded by today's tree, and only the cells inside the viewer's Access.
No percentage is stored. Points are daily and labelled UTC. Days with no Recorded day marker show as
gaps, days with no overlapping scan are marked, and the baseline is the newest Recorded day on or
before the window's start.

**Nothing is backfilled and nothing is rewritten.** `posture_snapshots` keeps being written, unchanged,
and is read only to bridge the days before recording began, through the version-equality table, for
the two views it can answer honestly: Everything with a category filter, and one whole subscription.
Every other level says "History at this level starts on <date>".

**The write contract.**

- One module, the trend-record module, writes every table above. Every posture input (a scan sync, a
  suppression, an expiry, a rule write, a placement change, a rekey) goes through it, in the
  transaction of the action that caused it, and an allowlist test fails any other writer.
- The record lock is taken last, after any name lock, and held only for reads, record inserts and
  `trend_state` updates. On Postgres it is one advisory lock; on SQLite the write transaction
  already serialises.
- A failed record write fails the action. A scan whose record could not be written fails, and a
  suppression whose record could not be written is not made. A record that silently lagged would be
  worse than a visible error.
- No write is dated before the newest row for its key. When the clock or an import would date a row
  earlier, it takes that row's date, and `seq` breaks ties inside a day.
- Deleting a rule writes its cells to 0 and keeps its last labels as a rule fact, so past days still
  show what it was.
- The startup and daily recounts recount every key from live state and write only the keys that
  differ.

**Retention.** Lifecycle finding events (created, reactivated, resolved, occurred) are kept 365
days, and row events (`row_added`, `row_removed`) 180. The trend record is kept 365 days, and
retention keeps each key's newest row at or before the cutoff and the newest marker older than the
cutoff, so the first day inside the window still reads correctly. There is no setting.

**Record versioning.** Every row carries a `record_version`. A change to what is stored bumps it, and
an equality table says which versions read the same. Days recorded under a version that does not
equal the current one are marked on the chart rather than blended in silently, and earlier rows are
not converted.

**The one written exception is a rule-id rename.** Findings, suppressions and `scan_findings` are
already rewritten when a rule's id changes, because an id-derived key must follow its id
([`data.md`](../conventions/data.md)). The trend tables are rewritten the same way, the only time a
past record is changed.

**Moving a rule to another category now moves its findings at once.** The category a finding is
counted under is the rule's category today, so a move regroups the live numbers, the cells and every
past trend point together. Recorded coverage is the exception: it keeps the categories as scanned,
so a moved rule's earlier scans do not mark its new category as covered.

## Why

`posture_snapshots` holds a finished percentage per category and per subscription. A percentage
cannot be narrowed after the fact: a rule can pass in one subscription and fail in another, so no
sum of per-subscription rows is a blended line, and a person who holds one resource group cannot be
served a row computed for the whole category. That is why the trend widget refused every filter but
two, and refused every scoped person. What can be narrowed is the inputs: the same cells, filtered
and added up by today's formula, give the percentage for any filter and any Access, and a formula
change reaches back over every recorded day instead of splitting the line in two.

Changes, not daily copies, because a day in which nothing moved costs nothing, and because a change
carries its own date, so a reader never has to guess which scan a number came from.

## Considered options

- **Store more percentages, one per filter combination.** Rejected. The combinations are the
  product of every filter and every Access, and none of them can be answered for a person it was not
  stored for.
- **Rebuild the past from finding events.** Rejected. Events say when a finding appeared and went,
  not what the rules were then, so a rule enabled or re-scoped later would rewrite history.
- **Backfill the record from `posture_snapshots`.** Rejected. A percentage cannot be turned back into
  cells. The bridge reads the snapshots where they answer the question and says so where they do not.
- **Write the record from a background job.** Rejected. A job can lag or fail without anyone
  seeing, and the numbers would disagree with Scans for a while. Writing in the action's own
  transaction keeps the record equal to live at every commit.
- **Cache computed trends.** Rejected. A cache is per person and per filter, so it would hold the
  Access problem in another form. The budgets below are met without one.

## Consequences

- **Budgets.** A 365-day read and the record write on a full sync each take under 1 second, and a
  suppression under 100 ms, on a large estate and on both backends, with no cache. They are
  uncontended medians, measured by `bench:trend`, not a ceiling for a busy install.
- **On SQLite a suppression during a sync waits for the whole sync.** There is one writer, so the
  100 ms budget holds when nothing else is writing.
- **Three limits, stated on the screen and in the docs:**
  1. Read consistency, the record equalling live, holds only from the retention cutoff onward.
     Rows before it are thinned to each key's newest row, so a point older than the cutoff is not
     promised to equal what a recount would give.
  2. Today's live point can be newer than the window rows. It is read from live state, so a change
     since the last record write shows in the last point and in no row.
  3. During the rolling-deploy overlap [`install.md`](../../public/install.md) allows, or after an
     older version ran, past days can disagree until the next daily recount. The recount corrects them
     dated when it runs and never rewrites earlier days, and days with no marker read as gaps.
- With every scheduler off, or a Demo with Reset off, nothing runs the daily recount, so idle days
  read as gaps and retention waits.
- A kind switch (Problem to Advisory) steps the line on its day. Earlier days are not rewritten.
- Clearing a rule's findings keeps them in past trend days while New vs Fixed loses those events.
- Every table is in both schema twins, and every date in them is text so a Demo Reset can shift it.
- Disk grows with changes, not with days, and with retention it is bounded by the 365 days above.
- Switching backends starts a new record, as it starts a new install.
