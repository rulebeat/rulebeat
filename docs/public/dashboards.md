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

A dashboard has one filter bar applied to every widget: categories, subscriptions, resource groups,
tags, severities, rules, and a date window. A funnel indicator appears on the bar and on each widget
title while a filter is active, so a scoped number never looks global. Tags here are **rule** tags
(labels like `framework:iso27001`), not Azure resource tags.

Each widget also has a **Scope** panel with the same dimensions. A value set there **replaces** the
dashboard's value for that dimension on that widget; anything left on inherit takes the dashboard's.
Values never intersect, so if the dashboard is filtered to production and a widget's Scope names the
sandbox subscription, that widget shows the sandbox.

The date window is a rolling preset (24 hours, 7 or 30 days) or a custom range. A preset is stored as
"7 days" rather than two dates, so it keeps rolling. It drives anything that says new, fixed or
delta, the Trend and New vs. Fixed charts, and "vs baseline". It does not change what counts as open.

Three limits a widget will tell you about. Trend needs snapshots at the right grain, so under a
resource group, tag, severity or rule filter, or with two or more subscriptions selected, it says a
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

## Present and print

A dashboard leaves your own screen two ways: **Present**, on a screen, and paper. Both show what you
see under your own [Access](access.md), never more, and both carry one **stamp**, the "As seen by" band,
so a number on a wall or in a printout says whose view it is and when.

### Present

Present opens at `/dashboards/<id>/present`. It is read-only and full screen: no editing, no filter
bar, just the widgets. Every number is still a link to the same count on Scans, so a click on a
finding count lands on the list it counted.

Present refreshes on its own. The layout and the numbers both reload at the dashboard's refresh
interval, or every 5 minutes when that interval is Off. To set a different pace for one screen, add
`?refresh=` to the address with one of 30s, 1m, 5m, 15m, 30m or 1h, for example
`/dashboards/<id>/present?refresh=15m`. Any other value falls back to the dashboard's interval. The
`?refresh=` value changes only that screen and is never saved to the dashboard.

### The stamp

The stamp is a band with six cells:

| Cell | Shows |
|---|---|
| **As seen by** | The person signed in, by name. |
| **Access** | What they hold, as counts by kind (for example subscriptions and resource groups), or **Everything**. |
| **Filters** | The filters in effect for that person. A filter value they do not hold is left out and counted as "+N outside your access". On screen a long list is cut short with "and N more". |
| **Updated** | When the numbers on the screen were last loaded. |
| **Widgets** | How many widgets are unavailable, those that show "Couldn't load this widget" instead of a number. |
| **Refreshes every** | The interval Present is using, from the dashboard, the 5 minute default or `?refresh=`. |

On paper the Filters cell lists every value, with no "and N more".

### The Everything notice

An Admin, or anyone holding Everything, sees a notice when they open Present: a wall screen shows the
whole install, not one team's part of it. The notice does not block the page. The
[Demo](demo-mode.md) does not show it. To put a team's numbers on a wall, use a dedicated person with
only that team's Scopes, as in [A screen on the wall](#a-screen-on-the-wall).

### When Present cannot show the dashboard

Present says why it has nothing to show, instead of a blank page that could pass for a clean estate.

- **Signed out.** The session ended, so Present asks you to sign in again and brings you back to the
  dashboard afterwards.
- **Forbidden.** You are signed in but no longer have access to this dashboard, for example it is no
  longer shared with you.
- **Unavailable.** The dashboard was deleted, or RuleBeat could not load it.

When a refresh fails after Present has already shown numbers, the last numbers stay on screen and the
stamp reads **Not updated since** the time of the last good load, so a stale wall screen is never
mistaken for a current one.

### Printing

Use the **Print** action on a dashboard, or Ctrl+P (Cmd+P on a Mac). The page is styled for paper and
the stamp is printed at the top. Landscape fits the grid best. Chrome and Edge pick it from the
dashboard; Safari does not, so Safari users choose landscape themselves in the print dialog.

One exception: charts are sized for the screen, and when you print from the browser's own Print menu
rather than the Print action, a chart can be scaled to the page width and look different from the
screen. Use the Print action for the closest copy.

## A screen on the wall

Present always shows a signed-in person's view, so a screen on the wall needs a person of its own.
There is no link-only or embed access, and no way to show a dashboard to someone who has not signed in.

1. **Invite a dedicated person** as a Viewer with Manual access to only that team's Scopes. How to pick
   the Scopes is in [Manual access](access.md#manual-access).
2. **Sign them in** on the screen however the install's sign-in policy allows: with Microsoft, or with a
   local account if the policy permits one ([`configure.md`](configure.md#sign-in)).
3. **Open Present** on the dashboard and, if the team wants a different pace, add `?refresh=`.

The session lasts while the screen keeps refreshing: each refresh renews it, so a screen that stays on
does not sign out. If the screen is switched off or loses its network for longer than the session
lasts, it shows the signed out screen when it comes back, and someone has to sign in again.

Present can't put the browser in full screen by itself after a reload. On a dedicated screen, start the
browser in kiosk mode: `--kiosk` for Chrome or Firefox.

A touch screen should run in kiosk mode, since a stray tap leaves Present and only someone with a
keyboard can undo it.
