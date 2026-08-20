# Dashboards

![Dashboard with the Overall Posture ring, category scorecard and trend](img/dashboard.png)

This page answers: which widgets exist, what question each one answers, how filters and date
windows work, and what a widget will refuse to show rather than show wrongly. The definition of the
number most widgets display is in [`posture.md`](posture.md); read that first if the question is
"what does 7 of 12 mean".

## Where the numbers come from

Every widget reads live state from the findings table (the same rows the Scans page shows) plus,
for trend lines, the daily posture snapshots. No widget reads "the last scan's result blob", so a
narrow scheduled run cannot make a dashboard swing. Suppressed findings are excluded everywhere on a
dashboard; the Scans page is where you go to see them.

## The widget catalog

<!-- count:widget-types -->Twelve widget types, added from the Add Widget panel:

| Widget | What it answers |
|---|---|
| **Stat Card** | One number. Pick a metric: checks passing (posture, as "X of Y passing"), open findings, critical, high severity, rules scanned, categories healthy, new findings in the window, fixed findings in the window. Shows the open-findings delta for the window under the value, and "N unknown" when some rules have not been proven. |
| **Posture Ring** | The "X of Y passing" gauge for one category or overall, with "N not yet proven" underneath when applicable. |
| **Trend Chart** | Posture % over time, as area, line or bars, one series per category. Only for scopes that have stored history; see Limits below. |
| **Top Violating Rules** | Which rules produce the most open findings. Click through to those findings on the Scans page. |
| **Category Scorecard** | One row per category: "X of Y passing", open findings, and the delta for the window. |
| **Recent Findings** | The newest findings as a compact feed with category, severity and first-seen date. Click a row to open it in Scans. |
| **Severity Breakdown** | A donut of open findings by severity. |
| **Subscription Scorecard** | One row per subscription: "X of Y passing" and open findings, graded against the rules that actually apply to that subscription. |
| **Top Offending Resources** | The resources with the most open findings across all rules, for the "which five things should I fix first" question. |
| **Scan Coverage** | Last scan time per category, badged fresh, recent, stale or never against a threshold you set (one week by default), with that run's complete/partial coverage. |
| **New vs. Fixed** | Remediation velocity: findings first seen versus findings fixed, per day, over the window. |
| **Activity Occurrences** | How often activity-pattern findings (sign-in risk, Graph audit events) recur, as a daily bar count over the window. No pass/fail posture here: activity findings age out rather than resolve. |

Every widget has a title you can rename, and a Scope panel (below). Widgets whose height should
follow their content (the scorecards, Recent Findings) shrink to fit; nothing on a dashboard ever
scrolls inside its own box, the page scrolls.

## Filters

A dashboard has one filter bar, applied to every widget on it: **categories, subscriptions,
resource groups, tags, severities, rules, and a date window**. A funnel indicator shows on the bar
and on each widget title whenever a filter is active, so a scoped number never looks like a global
one.

Each widget additionally has a **Scope** panel with the same dimensions. A value set there
**replaces** the dashboard's value for that dimension on that widget; a dimension left at "inherit"
(or empty) takes the dashboard's. Values never intersect or combine: if the dashboard is filtered to
the production subscription and a widget's Scope names the sandbox subscription, that widget shows
the sandbox. The widget-level window override offers the rolling presets only (24h, 7d, 30d, or
inherit); custom ranges live on the dashboard bar.

Tags here are **rule** tags (the free-form labels on a rule, such as `framework:iso27001`), not
Azure resource tags. Filtering by a rule tag scopes every widget to findings from rules carrying
that tag.

## Date windows

The window is either a rolling preset (last 24 hours, 7 days, 30 days) or a custom calendar range.
A preset is stored as "7 days", not as two dates, and resolved to concrete dates every time a
widget fetches, so a dashboard saved with "last 7 days" keeps rolling. The window drives anything
that says "new", "fixed" or "delta", the Trend and New vs. Fixed charts, and the "vs baseline"
comparison. It does not change what counts as an open finding: open is open regardless of when it
was first seen.

## Limits a widget will tell you about

- **Trend needs stored history at the right grain.** Snapshots are written per category and per
  single subscription. With a resource group, tag, severity or rule filter, or two or more
  subscriptions selected, the Trend widget says a trend is not available for that scope instead of
  drawing a misleading blended line. The full reasoning is in
  [`posture.md`](posture.md#snapshots-and-trend). The open-findings delta keeps working under every
  filter, because it is computed from live finding timestamps.
- **Unavailable is not empty.** A widget whose data request failed (server error, network, a
  malformed response) shows "Couldn't load this widget" with a Retry that re-fetches only that
  widget. A widget that genuinely has no data shows its own empty state. The two are never the same
  message, so a broken dashboard cannot pass for a clean tenant.
- **No enabled rules in scope** shows an empty posture rather than 0% or 100%.

## Managing dashboards

From the Dashboards page you can:

- **Create** a blank dashboard and add widgets to it.
- **Restore starter** to recreate the seeded "Overview" layout if you deleted or rearranged it.
- **Set default**: the dashboard that opens first. Every dashboard is deletable, including the
  default; deleting it promotes the oldest remaining one.
- **Duplicate** a dashboard to start a variant (a per-team or per-subscription view) from a known
  layout.
- **Rename**, and **Delete** (with confirmation).

Layouts are saved per dashboard. Dragging and resizing widgets is not written to the audit log,
since every drag would be an entry and would bury real changes; creating, renaming and deleting a
dashboard is audited. Viewers can see every dashboard; editing needs the editor role. See
[`rbac.md`](rbac.md).

## Click-throughs

Widgets that show findings or rules link to the Scans page with the matching filters already
applied: the same category, subscription, severity, rule and window you were looking at, so the
list you land on is the list the number counted. The Scans page and the dashboard use the same
filter predicate, and a test asserts they agree on the same finding set.
