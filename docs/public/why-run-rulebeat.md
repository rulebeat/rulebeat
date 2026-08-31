# Why run RuleBeat

The other pages explain how RuleBeat works. This one is about what the visibility is for.

Every rule belongs to a category. A fresh install seeds Compliance, Cost, Security, Identity and
Reliability, and admins can add their own, so scans, schedules, dashboards and notification routing
follow the areas your teams own. The built-in rules named below are examples, not the product. The
product is that any check you can write as a query gets the same treatment: scheduled runs, a
tracked history, honest posture, and a recommendation on every finding.

## Cost

Orphaned resources bill quietly forever. A managed disk left behind by a deleted VM, a public IP
nothing routes to, a snapshot of a disk that no longer exists. None of them appears on anyone's
board and each is on the invoice every month.

What your team counts as waste is wider than any fixed list, which is the point of a custom rule: a
SKU outside what your platform team approves, a resource in a region you do not operate in, a dev
resource in a production subscription. RuleBeat does not read your bill and does not estimate
savings. It shows you the resources.

## Security

The dangerous misconfigurations are rarely dramatic. A storage account that still answers plain
HTTP, a container allowing public blob access, a Key Vault without purge protection. Each is one
property on one resource, invisible until an incident makes it visible. Tracking each from first
seen to fixed makes "we closed that" a recorded fact with a date rather than a memory.

Because RuleBeat is read-only and never holds write credentials, pointing it at production is a
low-stakes decision. See [`security.md`](security.md).

## Compliance

Required tags, naming rules, allowed regions. Their usual home is a wiki page that went stale the
month it was written. A compliance rule turns a convention into a check that runs on a schedule, so
drift shows up as findings with a history and an audit stops being archaeology.

The built-in tag rules (Environment, Owner, CostCenter) ship disabled because tag names are
org-specific. Rename them to your taxonomy, or write your own. An `Owner` tag that is actually
present is also what makes every other finding actionable, because it answers who fixes this.

## Identity

App registration secrets and certificates expire on their own calendar, and the integration that
depends on one fails at whatever hour the clock runs out. Identity checks query Entra ID for
credentials close to expiry, so rotation stays routine work instead of an outage response. See
[`directory-rules.md`](directory-rules.md).

## Reliability

Microsoft publishes the Azure Proactive Resiliency Library, recommendations engineers otherwise
read once and apply from memory. RuleBeat ships APRL as a version-pinned pack, so they run against
your estate as part of ordinary scans with Microsoft's own guidance attached. Enabling one is a
click, not a porting project.

## Working on findings together

Visibility only pays off when a team can act on it:

- A rule is plain data your team can read and review, not a script on one laptop.
- A suppression carries a reason and an optional expiry, so an accepted risk is a documented
  decision instead of silence. See [`suppressions.md`](suppressions.md).
- Roles give an auditor or a neighbouring team read access without anything else, and every change
  lands in the audit log. See [`rbac.md`](rbac.md).
- Notification channels route by category, so the security channel hears about security findings
  and the platform channel hears about cost. See [`notifications.md`](notifications.md).
