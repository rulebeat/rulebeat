# Dashboards

![Dashboard with the Overall Posture ring, category scorecard and trend](img/dashboard.png)

The widget catalog, filters and date windows. If the question is what "7 of 12" means, read
[`posture.md`](posture.md) first.

Every widget reads live state from the findings table plus, for trend lines, the daily posture
snapshots. No widget reads the last scan's result blob, so a narrow scheduled run cannot make a
dashboard swing. Suppressed findings are excluded everywhere on a dashboard; the Scans page is where
you see them.

## The widget catalog

<!-- count:widget-types -->Thirteen widget types, added from the Add Widget panel:

| Widget | Shows |
|---|---|
| **Stat Card** | One number from a metric you pick: posture, open findings, critical, high, rules scanned, categories healthy, new or fixed. Carries the window's delta and any unknown count. |
| **Posture Ring** | The "X of Y passing" gauge for one category or overall, with "N not yet proven" underneath. |
| **Trend Chart** | Posture % over time, one series per category. Needs stored history. |
| **Top Violating Rules** | The rules producing the most open findings. |
| **Category Scorecard** | One row per category: passing, open findings, delta. |
| **Recent Findings** | The newest findings, with category, severity and first-seen date. |
| **Severity Breakdown** | A donut of open findings by severity. |
| **Subscription Scorecard** | One row per subscription, graded against the rules that apply to it. |
| **Top Offending Resources** | The resources with the most open findings. |
| **Scan Coverage** | Last scan time per category, badged fresh, recent, stale or never against your threshold. |
| **New vs. Fixed** | Findings first seen against findings fixed, per day. |
| **Activity Occurrences** | Daily findings from activity rules. Empty until the Log Analytics backend lands. |
| **Advisories** | Open Advisories with rule, resource, severity and when each was last seen, most severe first and then most recently seen. Advisories are never counted as problems, so this is the one widget that lists them. A row opens the Advisories tab on Scans. |

Widgets showing findings or rules click through to the Scans page with the same filters applied, so
the list you land on is the list the number counted.

## Filters and scope

A dashboard has one filter bar applied to every widget, with seven dimensions. Within a dimension the
values are any-of; across dimensions they are all-of. There is no exclude.

- **Category**: the categories the findings belong to.
- **Scope**: the Scopes the findings sit in, picked in one Scope picker.
- **Rule source**: where the rule comes from: a Pack, Community or Custom.
- **Rule tags**: the tags on the rule, such as `framework:iso27001`.
- **Severity**: the finding's own severity, bands included.
- **Rule**: the rules you name.
- **Date window**: the span new, fixed and delta are counted over.

A funnel indicator appears on the bar and on each widget title while a filter is active, so a scoped
number never looks global. Findings do not store Azure resource tags, so there is no filter on them
and tags here are always **rule** tags.

The **Scope filter** is matched the way Access is and can only narrow what you hold; it never widens
it. See [The Scope filter is not access](access.md#the-scope-filter-is-not-access).

Each widget also has a **Filters** panel with the same dimensions. For each one, the widget can
**Inherit** the dashboard's value, **Replace** it with its own, or be set to **Any**, which ignores the
dashboard's value for that dimension. The date window has two states: inherit or replace. Values
never intersect, so if the dashboard is filtered to production and a widget replaces its Scope with
the sandbox subscription, that widget shows the sandbox. The panel names every override the widget
carries and every dimension the widget does not apply, so a number is never narrowed by something you
cannot see. A saved-view summary follows its saved view and ignores the bar and the overrides.

The date window is a rolling preset from 24 hours to 365 days, or a custom range no more than 365 days
back. A preset is stored as "7 days" rather than two dates, so it keeps rolling. It drives anything
that says new, fixed or delta, the Trend and New vs. Fixed charts, and "vs baseline". It does not
change what counts as open.

**When a value is missing.** A filter keeps its values even when something has changed underneath it,
and says so rather than dropping them.

- A Scope outside your access is counted, not named, and matches nothing for you.
- A Scope Azure no longer lists is still named and marked "Not found in Azure". It matches the findings
  recorded against it.
- A deleted category still matches the findings recorded under it.
- Tags and packs that no rule carries match nothing.
- A long Scope list travels as a short reference. It opens only on the install that made it, and only
  while its row exists. Otherwise it shows as an unresolved Scope filter that matches nothing and says
  why.

Three limits a widget will tell you about. Trend needs snapshots at the right grain, so under a
tag, severity or rule filter, or with Scope picks other than a single subscription, it says a
trend is not available rather than drawing a misleading blended line
([`posture.md`](posture.md#snapshots-and-trend)); the open-findings delta keeps working under every
filter. A failed data request shows "Couldn't load this widget" with a Retry, while genuinely absent
data shows an empty state, so a broken dashboard cannot pass for a clean tenant. And no enabled
rules in scope shows an empty posture rather than 0% or 100%.

## Managing dashboards

Create a blank dashboard, duplicate one for a per-team variant, rename, delete, set the default, or
Restore starter to recreate the seeded Overview layout. Every dashboard is deletable including the
default; deleting it promotes the oldest remaining one. Layouts save per dashboard. Creating,
renaming and deleting is audited; dragging and resizing is not, since every drag would be an entry
and would bury real changes. Viewers see every dashboard, editing needs the editor role
([`rbac.md`](rbac.md)).
