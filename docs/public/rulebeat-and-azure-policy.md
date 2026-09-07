# RuleBeat and Azure Policy

Azure Policy and RuleBeat both check Azure resources against rules you choose, and both can run
without changing anything. This page is about where they overlap and where the work around a check
is different, checked against Microsoft's documentation for Azure Policy and against RuleBeat's own
code. Nothing here is a reason to switch off a Policy assignment.

## Where they overlap

An Azure Policy assignment with the `audit` effect records a compliance state and stops nothing,
which is also what a RuleBeat rule does. If your assignments are audit-only, someone reads the
compliance blade, and one person owns the whole loop from finding to fix, there is real overlap and
you may not need RuleBeat.

## Writing a check

In Azure Policy a check is a definition written in JSON: a `mode`, parameters, and a `policyRule`
with an `if` condition and a `then` effect. The condition can only address a resource property
through an alias, and Microsoft's own troubleshooting guidance for a property with no alias is to
open a support ticket. The definition is then assigned to a scope, and only after that does it
evaluate anything.

In RuleBeat a check is the KQL you already run in the Resource Graph blade, pasted in as it is, or
built in a visual builder that reads and writes the same KQL
([`authoring-rules.md`](authoring-rules.md)). Before you save it, you can run it against your
tenant and see the rows it returns. Every row is a finding, so what the rule shows and what Azure
returns cannot disagree. The field picker is fed by the same ARM provider aliases API that Azure
Policy uses, so it offers real property names, and raw KQL addresses a property directly as
Resource Graph does.

## Seeing the result

Azure Policy evaluates on its own cycle. A new assignment takes about five minutes to apply, every
assignment is re-evaluated once every 24 hours, a created or updated resource shows its state around
15 minutes later, and an on-demand scan is an asynchronous job that Microsoft describes as taking a
long time, because every assigned policy is evaluated.

In RuleBeat, Run Scan returns rows now. A schedule runs once, hourly, daily, weekly on chosen days,
or monthly on a fixed day ([`scans-and-schedules.md`](scans-and-schedules.md)), and each scheduled
run records, per rule, whether it succeeded, failed, was capped or was invalid.

## What a check can reach

Azure Policy evaluates Azure Resource Manager resources: the `all` and `indexed` modes, plus a fixed
list of data-plane modes for services such as Kubernetes, Key Vault and Managed HSM. There is no
Microsoft Entra ID mode. App registrations, service principals, users and groups are outside it.

A RuleBeat rule runs against Azure Resource Graph or against Microsoft Graph, over
<!-- count:graph-resource-types -->seven directory object types
([`directory-rules.md`](directory-rules.md)). The <!-- count:credential-expiry-rules -->two
built-in identity rules, expiring app registration secrets and certificates, are ordinary Graph
rules. Rules over logs and activity data in Log Analytics are designed and not yet available.

## What happens to a finding

Azure Policy records a compliance state per resource per assignment. The portal shows a chart of the
last seven days and 14 days of change history for a resource, and the compliance records are stored
in Azure Resource Graph, so any other view is a query against the `policyresources` table that you
write. An exemption, with a category of Waiver or Mitigated and an optional expiry date, takes a
resource out of evaluation.

RuleBeat keys every finding on rule plus resource and keeps it across scans: when it first appeared,
when it was last seen, how many times, and the date it was fixed
([`how-it-works.md`](how-it-works.md)). A finding is marked fixed only when its rule's own run
succeeded, so a query that broke never looks like a problem that went away. A run with any failed or
capped rule is badged partial, and a rule that has not run or whose run failed is unknown and never
counted as passing ([`posture.md`](posture.md)). A daily snapshot keeps the trend. A suppression is
RuleBeat's equivalent of an exemption: per finding, with a required reason, an optional expiry and
an audit log entry ([`suppressions.md`](suppressions.md)). Expiry is not a difference between the
two.

## Filtering and dashboards

The compliance blade filters by assignment, scope, definition type and compliance state. RuleBeat's
Results tab filters by category, severity, status, rule, subscription, resource group, location, tag
and date window, and exports to CSV and JSON. Every dashboard widget takes the same filters, and
there are <!-- count:widget-types -->12 widget types to arrange ([`dashboards.md`](dashboards.md)).

## Who hears about it

Azure Policy has no notification of its own. Compliance state changes are published to Azure Event
Grid, which Microsoft says can take up to 20 minutes, and you subscribe a Function, a Logic App or a
webhook to act on them, or build an alert on the Activity Log.

RuleBeat sends the new findings from a scheduled run to <!-- count:channel-types -->four kinds of
channel: Microsoft Teams, Slack, email, or a JSON webhook. A channel is attached per schedule with a
minimum severity, delivery retries on transient failures, and a per-channel delivery history
([`notifications.md`](notifications.md)).

## What Azure Policy does that RuleBeat does not

Azure Policy enforces at deployment time: `deny` and `denyAction` block a request, `modify` and
`append` change it, and `deployIfNotExists` deploys what is missing, with remediation tasks that run
under the assignment's managed identity. It ships hundreds of built-in definitions and initiatives,
including regulatory compliance standards, and it is in the portal for everyone with access to the
scope.

RuleBeat never enforces, never holds a write credential, and never blocks a deployment
([`security.md`](security.md)). It has no compliance framework mapping beyond the tags you put on a
rule, and it does not generate fixes: a finding shows the rule's own recommendation text. Enforcing a
standard is Azure Policy's job, and it does that better than anything you would write yourself.

## Running both

Keep Policy assignments for the standards you enforce. Put the checks that are yours, the ones no
built-in definition covers or that need to reach the directory, in RuleBeat, where they run on your
schedule and every finding has a history. Neither needs the other.

## Sources

Checked against these Microsoft Learn pages in September 2026:

- [Overview of Azure Policy](https://learn.microsoft.com/en-us/azure/governance/policy/overview)
- [Definition structure basics](https://learn.microsoft.com/en-us/azure/governance/policy/concepts/definition-structure-basics), for the modes
- [Aliases](https://learn.microsoft.com/en-us/azure/governance/policy/concepts/definition-structure-alias) and [Troubleshoot: alias not found](https://learn.microsoft.com/en-us/azure/governance/policy/troubleshoot/general)
- [The audit effect](https://learn.microsoft.com/en-us/azure/governance/policy/concepts/effect-audit)
- [Get compliance data](https://learn.microsoft.com/en-us/azure/governance/policy/how-to/get-compliance-data), for evaluation triggers, on-demand scans and the portal views
- [Determine causes of non-compliance](https://learn.microsoft.com/en-us/azure/governance/policy/how-to/determine-non-compliance), for change history
- [Reacting to Azure Policy state change events](https://learn.microsoft.com/en-us/azure/governance/policy/concepts/event-overview)
- [Exemption structure](https://learn.microsoft.com/en-us/azure/governance/policy/concepts/exemption-structure)
- [Remediate non-compliant resources](https://learn.microsoft.com/en-us/azure/governance/policy/how-to/remediate-resources)
