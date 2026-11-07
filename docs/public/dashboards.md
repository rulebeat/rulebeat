# Dashboards

![Dashboard with the Overall Posture ring, category scorecard and trend](img/dashboard.png)

The widget catalog, filters and date windows. If the question is what "7 of 12" means, read
[`posture.md`](posture.md) first.

Every widget reads live state from the findings table plus, for trend lines, the stored Trend points.
No widget reads the last scan's result blob, so a narrow scheduled run cannot make a
dashboard swing. Suppressed findings are excluded everywhere on a dashboard; the Scans page is where
you see them.

## The widget catalog

<!-- count:widget-types -->Thirteen widget types, added from the Add Widget panel:

| Widget | Shows |
|---|---|
| **Stat Card** | One number from a metric you pick: posture, open findings, critical, high, rules counted, categories healthy, new or fixed. Carries the window's delta and any unknown count. |
| **Posture Ring** | The "X of Y passing" gauge for one category or overall, with "N not yet proven" underneath. |
| **Trend Chart** | Posture % over time, one series per category, from Trend points kept for the whole install, each subscription and the Directory. A line is drawn only where the stored points mean the same as the live number ([`posture.md`](posture.md#when-two-counts-are-compared)). |
| **Top Violating Rules** | The rules producing the most open findings, each shown at its highest open severity. |
| **Category Scorecard** | One row per category: passing and open findings. |
| **Recent Findings** | The newest findings, with category, severity and first-seen date. |
| **Severity Breakdown** | A donut of open findings by severity. |
| **Subscription Scorecard** | One row for every known subscription, including ones with no findings, and a Directory row if you hold the Directory, each graded against the rules whose scope includes it. A footer counts the findings placed outside any subscription or the Directory and opens them on Scans. |
| **Top Offending Resources** | The resources with the most open findings. |
| **Scan Coverage** | Last scanned per category, badged fresh, recent, stale or never against your threshold, with the number of incomplete rules of every kind (failed, capped or invalid last run), which opens them on the Rules tab. Last scanned follows what you hold: for anyone without Everything it is the newest scan that covered part of it. |
| **New vs. Fixed** | Findings first seen against findings fixed, per day. The totals are the Scans New and Fixed lists for the window. |
| **Activity Occurrences** | Daily findings from activity rules. Empty until the Log Analytics backend lands. |
| **Advisories** | Open Advisories with rule, resource, severity and when each was last seen, most severe first and then most recently seen. Advisories are never counted as problems, so this is the one widget that lists them. A row opens the Advisories tab on Scans. |

Widgets showing findings or rules click through to the Scans page with the same filters applied, so
the list you land on is the list the number counted.

## Filters and scope

A dashboard has one filter bar applied to every widget: categories, subscriptions, resource groups,
tags, severities, rules, and a date window. A funnel indicator appears on the bar and on each widget
title while a filter is active, so a scoped number never looks global. Tags here are **rule** tags
(labels like `framework:iso27001`), not Azure resource tags.

Each widget also has a **Scope** panel with the same dimensions. A value set there **replaces** the
dashboard's value for that dimension on that widget; anything left on inherit takes the dashboard's.
Values never intersect, so if the dashboard is filtered to production and a widget's Scope names the
sandbox subscription, that widget shows the sandbox.

The date window is a rolling preset (Today (UTC), 7 or 30 days) or a custom range. A preset is
stored as "7 days" rather than two dates, so it keeps rolling, and N days is exactly N UTC days. It
drives anything that says new, fixed or delta, the Trend and New vs. Fixed charts, and the baseline
a change is measured against. It does not change what counts as open.

Three limits a widget will tell you about. A trend is served only for a category, the date window,
and at most one subscription or the Directory. Under any other filter it says a trend is not
available rather than drawing a misleading blended line
([`posture.md`](posture.md#what-each-widget-counts)); the open-findings change keeps working under
every filter. A failed data request shows "Couldn't load this widget" with a Retry, while a known
reason shows that reason with no Retry, so a broken dashboard cannot pass for a clean tenant. And a posture with nothing to count says why: you hold no access,
no rule looks at anything you hold, or a filter left nothing, rather than showing 0% or 100%.

## Managing dashboards

Create a blank dashboard, duplicate one for a per-team variant, rename, delete, set the default, or
Restore starter to recreate the seeded Overview layout. Every dashboard is deletable including the
default; deleting it promotes the oldest remaining one. Layouts save per dashboard. Creating,
renaming and deleting is audited; dragging and resizing is not, since every drag would be an entry
and would bury real changes. Viewers see every dashboard, editing needs the editor role
([`rbac.md`](rbac.md)).
