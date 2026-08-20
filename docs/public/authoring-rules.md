# Authoring rules

![Visual rule builder showing a condition group mid-edit](img/rule-builder.png)

A rule is a check that turns every row or object it returns into a finding. When you create one,
the first question the editor asks is **"What does this rule check?"**, with three answers:

- **Resource configuration.** The rule runs against Azure Resource Graph. You can build it
  visually, drop into raw KQL, or start from raw KQL and let RuleBeat parse it back into the visual
  builder. Most of this page is about this kind.
- **Directory objects.** The rule runs against Microsoft Graph, for checks about the directory
  itself (app registrations, service principals, users, groups) rather than Azure resources. See
  [`directory-rules.md`](directory-rules.md); the short version is further down this page.
- **Logs & activity.** Not available yet. The option is visible in the picker so the shape of the
  product is honest about where it is going; see [`whats-next.md`](whats-next.md).

Whichever kind you pick, the rule lands in the same Rules tab, runs in the same scans, produces
findings with the same lifecycle, and can be suppressed, scheduled, dashboarded and notified on the
same way. The backend changes how a rule is written and run, not what you can do with its results.

## Scope

Every Resource configuration rule targets one of four levels:

- **Resource** (most common). Runs against `Resources` in Azure Resource Graph, optionally
  narrowed to specific resource types.
- **Resource group.** Runs against the resource group itself as an entity, for checks like "every
  resource group must have a team tag," not its contents.
- **Subscription.** Runs against the subscription as an entity, for checks like "every
  subscription must declare its purpose."
- **Management group.** Same idea, one level higher.

A resource-level rule can be further scoped to specific subscriptions or management groups, so a
rule can apply only to production subscriptions, for example, without needing a separate copy for
every environment.

## Conditions

A rule's conditions are field, operator, value triples, combined with and/or, optionally grouped.
The visual builder currently offers <!-- count:visual-operators -->34 operators, grouped by what
they check: presence (`exists`, `isNull`, `isEmpty`, `isTrue`, and their opposites), equality and
text matching (`equals`, `contains`, `startsWith`, `endsWith`, `matchesRegex`, and their
opposites), set membership (`in`, `has`, `hasAny`, and their opposites), numeric and date
comparison (`gt`, `gte`, `lt`, `lte`, `between`, `olderThanDays`, `withinLastDays`), and array
shape (`arrayEmpty`, `arrayLengthGt`, `arrayContains`, and related checks). Fields can be
top-level resource properties (`name`, `location`, `type`, `kind`, `tenantId`, `managedBy`),
nested properties (`properties.something`), or tags (`tags.owner`). The field picker is fed by the
ARM provider aliases API, the same source Azure Policy uses, so it offers the real properties of a
resource type rather than whatever happened to be set on the resources you sampled.

Conditions describe what makes a resource **non-compliant**. A rule that requires an `owner` tag
is written as "flag anything where the `owner` tag does not exist," and the query it compiles to
is that violation query directly. This matters if you are reading a rule's generated KQL and
expecting to see the positive requirement spelled out: you are looking at its negation.

## Applies to

By default a rule is measured against every resource in its scope, so a finding count tells the
whole story on its own: three findings means three things wrong. Some rules are really assertions
about a smaller population, and a bare count stops being useful. "Every production VM must have
backup enabled" is that kind of rule: three findings out of three production VMs is a real
problem, three findings out of four hundred VMs total is probably already handled.

Applies to is an optional second query that defines that population, built with the same visual
builder as conditions. It is off by default, which is exactly the behaviour described above: the
rule is measured against everything in scope. Turn it on and RuleBeat runs it as its own count
alongside the rule's usual query, then shows findings for that rule as "3 of 40 affected" instead
of a bare "3 resources affected." Applies to is a Resource configuration feature; Directory rules
do not have it.

## Raw KQL

Any Resource configuration rule can be authored as raw KQL instead of, or alongside, structured
conditions. This is the escape hatch for anything the visual builder cannot express: joins,
aggregations, computed columns, or anything Azure Resource Graph supports that does not map onto a
simple filter. A rule with no structured conditions and no raw KQL would otherwise match every
resource in scope, so RuleBeat guards against that specific case rather than letting an empty rule
silently fire on everything. A raw-KQL rule whose rows do not carry an `id` column is refused at
save time for a related reason: without a resource id every row would collapse onto one finding.

## Directory rules (the short version)

Some checks are not about Azure resources at all. They are about the directory itself: which app
registrations have credentials about to expire, which service principals exist, which accounts are
disabled. RuleBeat runs these as Microsoft Graph rules, a separate engine from Azure Resource Graph
with its own query shape and its own permission (see [`permissions.md`](permissions.md)).

A Directory rule picks one of <!-- count:graph-resource-types -->seven object types (users,
groups, applications, service principals, directory roles, devices, or administrative units) and
an optional OData `$filter`, for example `accountEnabled eq false`. Every object the query returns
becomes a finding, the same "every row is a finding" model as a Resource Graph rule. Which of the
seven types actually return data depends on the Graph permission you granted: the documented grant,
`Application.Read.All`, covers applications and service principals. Other object types need their
own read permission.

Some checks are really about items nested inside each object rather than the object itself, like
an app registration's client secrets or certificates. Turning on "Flag expiring items" lets a rule
look inside a named array field, read a date field on each entry, and turn every entry within a
chosen number of days of that date into its own finding, at a severity you set per band, for
example critical inside 7 days, high inside 14, medium inside 30. RuleBeat's
<!-- count:credential-expiry-rules -->two built-in credential-expiry checks (expiring app secrets
and expiring app certificates) are ordinary rules built this way, not special cases, so the same
mechanism is available to any rule you write.

Directory rules have their own Validate action, same idea as raw KQL's: it runs the query against
your connected Azure identity and shows a match count and a few sample rows before you turn the
rule on. The full guide, with worked filters and the permission story, is
[`directory-rules.md`](directory-rules.md).

## Round-tripping between the builder and raw KQL

RuleBeat's KQL parser aims to never lose anything: most real-world KQL you paste in, including
queries copied from the Azure Portal or from external rule packs, either maps onto the visual
builder's fields and operators, or is preserved verbatim as a read-only passthrough condition. In
either case you can switch back and forth between the visual and raw views without losing a
clause. Measured across the <!-- count:pack-rules:aprl-v2 -->143 rules in the APRL pack, two still
lose a filter line on the round trip; a small number of edge cases in condition-value parsing
(values containing the literal text ` and ` or ` or `, or a trailing `| limit` stage) are still
being hardened. If a saved rule's raw KQL ever looks different from what you pasted in, treat that
as a bug report, not expected behaviour.

## Testing a rule before saving it

The rule editor has a Validate action that runs the rule's actual query against your connected
Azure identity and shows what it would currently match, so you can check a new rule's precision
before turning it on and generating findings against it.

## Rule provenance

Every rule has a `type`: `builtin` (shipped with RuleBeat, including the
<!-- count:pack-rules:aprl-v2 -->143-rule Azure Proactive Resiliency Library pack, pinned to a
named upstream commit in `data/packs/pack-manifest.json`), `community`, or `custom` (anything you
write yourself). Built-in rules can be disabled or have their severity and tags edited, but not
overwritten, so an update to RuleBeat will not silently discard a change you made to a shipped
rule. Custom rules are entirely yours to edit or delete. Duplicate any rule to start a custom one
from it.

Tags are free-form labels (for example `mcsb:*` for Microsoft Cloud Security Benchmark mappings,
or your own naming convention) used for filtering, dashboard scoping, and schedule targeting. They
are independent of category, so a rule can belong to the security category and also carry a
`framework:iso27001` tag.
