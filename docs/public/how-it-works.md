# How it works

This page answers one question: what happens between a rule you wrote and a finding on the Scans
page. It is for the engineer who wants to trust the number before putting it on a dashboard, and it
describes the shipped code, file by file, so the claims can be checked.

## The request path

```
 browser
   |  POST /api/scans/run            (manual: Run Scan button)
   |  scheduler tick, every 30s      (scheduled: a due schedule)
   v
 run executor (lib/run-executor.ts)
   |  one run, recorded in schedule_runs; busy flag so runs never overlap
   v
 per category: runCategoryScan (lib/scan-runner.ts)
   |  enabled rules partitioned by Rule.queryBackend
   |
   |-- resource-graph  --> runRules()       (core engine/runner.ts)    --> Azure Resource Graph
   |-- microsoft-graph --> runGraphRules()  (core engine/graph-runner.ts) --> Microsoft Graph
   |
   |  each rule yields findings, then exactly one outcome:
   |  success | failed | capped | invalid
   v
 save scan + sync findings (lib/scan-history.ts)
   |  upsert into the findings table by fingerprint; resolve only on success
   v
 daily posture snapshot (lib/db/snapshots.ts)
```

Every Azure call is made with one identity, resolved in exactly one place
(`packages/web/lib/azure-credential.ts`): environment variables first, then a credential an admin
entered under Settings, then managed identity or the local `az login` session. The user who clicked
Run Scan is never the identity that scans; their sign-in token is only ever used to sign them in.

## Two engines, not one engine with a branch

A rule carries a `queryBackend`. Today two values run:

**`resource-graph`.** The rule is, or compiles to, a KQL query against Azure Resource Graph.
`runRules()` sends that query, with the rule's subscription or management group scope passed as a
request parameter rather than written into the KQL, and treats **every row that comes back as a
finding**. There is no in-memory evaluator that re-checks rows against the rule's conditions; the
query is the rule, so what the builder shows and what Azure returns cannot disagree. A raw KQL rule
that does not project `type`, `location`, `resourceGroup` or `subscriptionId` gets them backfilled:
three come free from parsing the ARM resource id, and `location` comes from one follow-up
`resources | where id in (...)` query, never by rewriting the rule's own KQL.

**`microsoft-graph`.** The rule is a Graph request: one of
<!-- count:graph-resource-types -->seven allowlisted object types, an optional OData `$filter`,
and optionally a "Flag expiring items" expansion that turns entries inside an array field into
their own findings. `runGraphRules()` is a separate engine, not a branch inside the Resource Graph
one, because a directory object is not an ARM resource: it has no subscription, resource group or
location, and the ARM-shaped assumptions in the first engine would be wrong for it. Keeping the
engines apart also makes failure isolation a property of each engine rather than a wrapper someone
has to remember. See [`directory-rules.md`](directory-rules.md).

Both engines run inside the same `runCategoryScan` call and feed the same per-rule accounting, so a
scan, a run history row, a dashboard and a notification do not know or care which engine produced a
finding.

A third value, `log-analytics`, exists as a type and as a disabled tile in the rule picker. It does
not run anything yet.

## How a row becomes a finding

Each row is given a **fingerprint**: `sha256(ruleId::resourceId)`, truncated to 16 hex characters.
That is the finding's identity across scans. The same resource failing the same rule tomorrow is the
same finding, seen one more time, not a new one. Renaming a rule's id would therefore orphan every
finding under it, which is why built-in rule ids are stable UUIDs and a pack sync never changes them.

The finding carries what the query returned (resource id, name, type, location, resource group,
subscription, and whatever extra columns the rule projected, stored as evidence), plus the rule's
severity, category and title at the time of the scan.

## One outcome per rule

A scan is not a bare list of findings. After its findings, every rule yields exactly one outcome:

| Outcome | Meaning |
|---|---|
| `success` | The query ran to completion. Its findings are the complete set. |
| `failed` | The query threw (bad KQL, a permission error, a timeout after retries). Its old findings are left as they were. |
| `capped` | The result came back truncated, a follow-up page was truncated, or the KQL has a top-level `take`/`limit`. Findings are real but not exhaustive. |
| `invalid` | A raw KQL rule returned rows without an `id` column, so rows could not be told apart. |

A thrown query is caught per rule, so one broken rule never aborts the rest of the scan. On the
Graph side each rule's request is wrapped on its own as well, so one object type you lack
permission for does not take down its sibling rules.

## How a scan keeps or resolves findings

`syncScanFindings()` upserts this scan's findings into the `findings` table by fingerprint. A
fingerprint seen before has its `lastSeenAt` and `timesSeen` updated; a new one is inserted with
`firstSeenAt` set to now. A finding that was active before and did not reappear is marked **fixed**
only if its rule's outcome in this scan was `success`. A `failed`, `capped` or `invalid` rule keeps
every prior finding exactly as it was, because "the query broke" and "the problem is gone" must
never be the same signal.

Two statuses are stored: `active` and `fixed`. "New" is decided at display time, not stored: a
finding is shown as new when its `firstSeenAt` falls inside the date window you are looking at, and
as active otherwise. Nothing is ever computed by comparing one scan to the previous one, so a narrow
scheduled run that only touched three rules cannot make the other rules' findings look new or gone.

## Coverage

A run whose rules all ended in `success` is badged **complete**. Any other outcome makes it
**partial**, and the run record lists which rules were incomplete and why. Run History shows the
badge; the Scan Coverage dashboard widget shows it per category; the Rules tab shows the reason per
rule as a chip ("not yet run", "query failed", "result capped", "no resource id"). Partial coverage
is surfaced, never folded into the posture figure. How that figure is computed is in
[`posture.md`](posture.md).

## Suppressions, dashboards, notifications

A suppression is a row keyed by the same fingerprint, with a reason and an optional expiry. It hides
the finding from the Results tab by default and from every dashboard figure, and it is the one thing
that can make a rule with a finding count as passing. The finding itself keeps its history. See
[`suppressions.md`](suppressions.md).

Dashboards read the live `findings` table for counts and a daily `posture_snapshots` table for
trend lines. Notifications are sent only for a scheduled run's *new* findings, through the channels
that schedule assigned, after the run is saved. See [`dashboards.md`](dashboards.md) and
[`notifications.md`](notifications.md).

## Where data lives

Everything is one SQLite database in the `data/` directory (or the Docker named volume): rules and
their KQL, findings, scans, schedules and their runs, suppressions, dashboards, users, the audit log,
notification channels and delivery history, posture snapshots. Three kinds of field are encrypted
with AES-256-GCM before they are written: the Azure client secret, the SSO client secret, and every
notification channel's destination (webhook URL or SMTP password). The key lives next to the
database unless you move it; [`security.md`](security.md) spells out what that does and does not
protect.

Nothing is sent to a service RuleBeat operates. Outbound connections go to Azure management and
Resource Graph endpoints, Microsoft Graph, and the notification destinations you configured. There
is no telemetry.

## What is cached

The field picker in the rule builder is fed by the ARM provider aliases API, the same source Azure
Policy uses for its own aliases. Resource types and their property schemas are cached on disk under
`data/schemas/` (seven days for a type's properties, one day for the list of types) and served
stale-while-refreshing, so authoring a rule does not wait on an ARM round trip and an air-gapped
install still has the last good schema. Findings and posture are never cached; every scan reads
Azure fresh.

## Logs & activity

Not available yet. The rule picker shows the option disabled so the shape of the product is honest
about where it is going.
