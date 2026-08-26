# Why run RuleBeat

The rest of these pages explain how RuleBeat works. This one explains what the visibility is
for: the outcomes a team buys when the checks it cares about run on a schedule instead of
living in someone's head.

Every rule belongs to a category. A fresh install seeds Compliance, Cost, Security, Identity
and Reliability, and admins can add their own in Settings, so scans, schedules,
dashboards and notification routing can follow the areas your teams actually own. The built-in
rules named below are examples, not the product. The product is that any check you can write as
a query gets the same treatment: scheduled runs, a tracked history, honest posture, and a
recommendation attached to every finding. See [`authoring-rules.md`](authoring-rules.md) for
how a rule is written and [`examples.md`](examples.md) for four worked end to end.

## Cost: stop paying for what nobody uses

Orphaned resources bill quietly forever. A managed disk left behind by a deleted VM, a public
IP address nothing routes to, a snapshot of a disk that no longer exists: none of them appears
on anyone's board, and each one is on the invoice every month. RuleBeat's cost checks find
resources you are still paying for but no longer use, and the next scheduled scan surfaces a
new one instead of waiting for the next cleanup sprint.

The built-ins cover the common orphans. What your team counts as waste is wider than any fixed
list, which is why a custom rule gets the same scan, history and dashboards: a SKU outside what
your platform team approves, a resource in a region you do not operate in, a dev resource
sitting in a production subscription. If you can query it, you can watch it. RuleBeat does not
read your bill and does not estimate savings; it shows you the resources, and removing them
stays your change, made with the access you already have.

## Security: find quiet misconfigurations before they matter

The dangerous misconfigurations are rarely dramatic. A storage account that still answers plain
HTTP, a container that allows public blob access, a Key Vault without purge protection: each is
one property on one resource, invisible until an incident makes it visible. RuleBeat's security
checks surface these quietly wrong properties and track each one from first seen to fixed, so
"we closed that" is a recorded fact with a date, not a memory.

Your own security bar is expressible the same way: the settings that are mandatory in your
estate even where Azure calls them optional. And because RuleBeat is read-only and never holds
write credentials, pointing it at production is a low-stakes decision; see
[`security.md`](security.md) for exactly what it can and cannot touch.

## Compliance: standards that verify themselves

Every organisation has conventions: required tags, naming rules, allowed regions. Their usual
home is a wiki page that went stale the month it was written. A compliance rule turns a
convention into a check that runs on a schedule, so the standard is verified by scans, drift
shows up as findings with a history, and an audit stops being archaeology because the evidence
already exists.

The built-in tag rules (Environment, Owner, CostCenter) ship disabled because tag names are
org-specific: rename them to your own taxonomy and enable them, or write your own from scratch.
An `Owner` tag that is actually present is also what makes every other finding actionable,
because it answers who fixes this.

## Identity: no surprise expiries

App registration secrets and certificates expire on their own calendar, and the integration
that depends on one fails at whatever hour the clock runs out. RuleBeat's identity checks query
Entra ID for credentials that are close to expiry, so rotation happens while it is still
routine work instead of an outage response.

Directory rules are first-class: the same builder and the same workflow, pointed at Microsoft
Graph instead of Resource Graph, and you can write your own against applications, service
principals, users, groups and more. See [`directory-rules.md`](directory-rules.md).

## Reliability: Microsoft's guidance, run as checks

Microsoft publishes the Azure Proactive Resiliency Library, recommendations that engineers
otherwise read once in a browser and apply from memory. RuleBeat ships APRL as a version-pinned
pack, so those recommendations run against your estate as part of ordinary scans and appear as
findings with Microsoft's own guidance attached. Enabling one is a click in the Rules tab, not
a porting project, and the pack manifest records exactly which upstream version you are
running.

## Built to be worked on together

Visibility only pays off when a team can act on it, so the collaboration surface is deliberate:

- A rule is plain data your whole team can read and review, not a script on one laptop.
- A suppression carries a reason and an optional expiry, so an accepted risk is a documented
  decision instead of silence. See [`suppressions.md`](suppressions.md).
- Roles let you give an auditor or a neighbouring team read access without giving them anything
  else, and every change lands in the audit log. See [`rbac.md`](rbac.md).
- Notification channels route by category, so the security channel hears about security
  findings and the platform channel hears about cost. See
  [`notifications.md`](notifications.md).
- The whole platform is open source (Apache-2.0) and self-hosted, so evaluating it is a
  `docker run` in your own subscription, and improving it is a pull request. See
  [`install.md`](install.md).
