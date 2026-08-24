# Worked examples

This page answers: what does a rule actually look like from the form to the finding? Four rules,
end to end: the settings as the editor shows them, the query RuleBeat runs, a finding as it lands
on the Scans page, what the dashboard does with it, and the exact permission each one needs.

Every sample finding on this page comes from **demo mode's synthetic data**
([`demo-mode.md`](demo-mode.md)), not from a real tenant, so the ids and names are invented. The
shape of each finding is the shape a real scan produces; only the values are made up. The queries
are the real ones: copied from the rule definitions and from the builder's own output.

## Example A: a tag standard, measured as "X of Y"

**The standard:** every virtual machine in a production resource group must carry an `owner` tag.

**Kind of check:** Resource configuration (Azure Resource Graph).

**Permission:** the Reader role on the subscriptions in scope. Nothing else.

### What you set in the form

| Field | Value |
|---|---|
| Name | VMs in production must carry an owner tag |
| Category | compliance |
| Severity | medium |
| Scope | Resource (every subscription the identity can read) |
| Resource types | Virtual machines (`microsoft.compute/virtualmachines`) |
| Violates when | `tags['owner']` **is empty** |
| Applies to | on: `resourceGroup` **starts with** `prod-` |

"Violates when" is the condition that makes a resource a finding. "Applies to" is optional and
does not change which resources are flagged; it defines the population the rule is measured
against, so the Rules tab reads "3 of 40 affected" rather than a bare count of 3. See
[`authoring-rules.md`](authoring-rules.md#applies-to).

### The queries RuleBeat runs

The builder compiles the violation into this KQL, shown live in the editor's query pane:

```kql
Resources
| where type in~ ('microsoft.compute/virtualmachines')
| where isempty(tostring(tags['owner']))
| project id, name, type, location, resourceGroup, subscriptionId, tags
```

With Applies to on, a scan runs a second query for the population: the same table and type
filter, the Applies to conditions, and a count.

```kql
Resources
| where type in~ ('microsoft.compute/virtualmachines')
| where resourceGroup startswith 'prod-'
| count
```

Note what the violation query does not do: it does not restrict itself to `prod-` resource
groups. A VM in `dev-sandbox` without an owner tag is still flagged. If you want the rule to
**only look at** production, put the resource-group condition under Violates when (or the rule's
Scope) as well. Applies to is the denominator, not a filter.

### The finding

The built-in **Missing Owner Tag** rule (disabled by default, because every organisation spells its
tag differently) is the same check without the type and population restriction. In the demo data
it produces, among others:

| Field | Value |
|---|---|
| Title | Missing Owner Tag |
| Resource | `nic-checkout-5` |
| Type | `microsoft.network/networkinterfaces` |
| Resource group | `rg-web-prod` |
| Subscription | `00000000-0000-0000-0000-000000000001` |
| Severity | medium |
| Status | active, first seen at the start of the sixty-day demo history, seen in every run since |
| Evidence | `{}` (the query projects no extra columns; the absence of the tag is the whole point) |
| Portal link | the resource's page in the Azure portal |

Your VM variant produces the same row shape, for VMs only, with `tags` in the evidence because the
builder projects it.

### On the dashboard

One failing rule in the compliance category. With Applies to on, the Rules tab shows "N of M
affected" for this rule; the posture figure still counts it as one failing rule, whatever M is
([`posture.md`](posture.md#applies-to-changes-the-reading-of-a-single-rule-not-the-posture)). Fix
the tags and the next successful scan marks each finding fixed; suppress one with a reason if a
specific VM is a sanctioned exception.

## Example B: a raw KQL rule from the built-ins

**The standard:** storage accounts must refuse plain HTTP.

**Kind of check:** Resource configuration. This is the built-in **Storage Account Allows HTTP
Traffic** rule (security, medium, enabled by default), written as raw KQL rather than in the
builder.

**Permission:** Reader on the subscriptions in scope.

### The rule as shipped

```kql
Resources
| where type =~ 'microsoft.storage/storageaccounts'
| where properties.supportsHttpsTrafficOnly != true
| project id, name, type, location, resourceGroup, subscriptionId, supportsHttpsTrafficOnly=properties.supportsHttpsTrafficOnly
```

Open it in the editor and the builder parses the raw KQL back into a visual condition
(`properties.supportsHttpsTrafficOnly` **is false**) so you can edit it either way. Any line the
builder cannot express is kept as a read-only passthrough block and re-emitted verbatim, never
dropped; see [`authoring-rules.md`](authoring-rules.md#round-tripping-between-the-builder-and-raw-kql).

Every column the query projects beyond the standard six lands in the finding's evidence, which is
why this rule projects `supportsHttpsTrafficOnly`: the finding carries the value that failed.

### The finding

From the demo data:

| Field | Value |
|---|---|
| Title | Storage Account Allows HTTP Traffic |
| Resource | `stportal8rganalyticsprod` |
| Type | `microsoft.storage/storageaccounts` |
| Resource group | `rg-analytics-prod` |
| Severity | medium |
| Status | active, seen in every run across the sixty-day history |
| Evidence | `{"supportsHttpsTrafficOnly": false}` |

The finding's recommendation text is the rule's description: "Allowing HTTP traffic to storage
accounts exposes data in transit. All access should be restricted to HTTPS." There is no generated
fix step today; see [`whats-next.md`](whats-next.md).

### What a scan does with it over time

The finding's fingerprint is the hash of the rule id and the resource id. Every scan that returns
the same row bumps last seen and times seen. The first successful scan of this rule that does not
return the row marks it fixed. A scan where this rule's query failed leaves the finding exactly as
it was, and the rule shows "query failed" in the Rules tab instead of quietly claiming the account
was fixed. See [`how-it-works.md`](how-it-works.md#one-outcome-per-rule).

## Example C: a reliability rule from the APRL pack

**The standard:** load balancers should use the Standard SKU.

**Kind of check:** Resource configuration. This is rule `38c3bca1-97a1-eb42-8cd3-838b243f35ba`,
**Use Standard Load Balancer SKU** (reliability, high), from the Azure Proactive Resiliency Library
v2 pack.

**Permission:** Reader on the subscriptions in scope.

### Provenance

The pack is Microsoft's Azure Proactive Resiliency Library v2 (MIT licence), synced at a pinned
upstream commit (`1824eb5958d11482f6e23c231f0cb1d2d5bd44f6`, recorded in
`packages/web/data/packs/pack-manifest.json` with the label, source URL, licence and rule count).
The pack is seeded on startup and every one of its <!-- count:pack-rules:aprl-v2 -->143 rules
ships **disabled**; you enable the ones that fit your estate. An upgrade keeps your enabled state,
severity and any query edit on a pack rule; only the rule's name, pack label and resource type
list are kept in step with the pack. See [`authoring-rules.md`](authoring-rules.md#rule-provenance).

In the Rules tab the rule carries an "APRL v2" pack label. The trailing "Learn more" URL in the
upstream description is split out and shown as a **Read the official guidance** link on the finding
(for this rule, Microsoft's Well-Architected page on load balancer reliability), so the vendor's
own remediation guidance is one click away even though RuleBeat does not generate fix steps.

### The rule as shipped

```kql
// Azure Resource Graph Query
// Find all LoadBalancers using Basic SKU
resources
| where type =~ 'Microsoft.Network/loadBalancers'
| where sku.name == 'Basic'
| project recommendationId = "38c3bca1-97a1-eb42-8cd3-838b243f35ba", name, id, tags, Param1=strcat("sku-tier: basic")
```

Two things this query shows about how RuleBeat runs other people's KQL:

- It projects `name`, `id` and `tags` but not `type`, `location`, `resourceGroup` or
  `subscriptionId`. RuleBeat recovers type, resource group and subscription from the resource id
  string and fetches location with one follow-up `resources | where id in (...)` query. It never
  rewrites the rule's own KQL to do so.
- `recommendationId` and `Param1` are extra projected columns, so they land in the finding's
  evidence as-is.

### A caveat on the pack

Not every upstream APRL recommendation ships with a finished query. Some files in the library are
placeholders marked `under-development`; enabling such a rule gives a `failed` outcome ("query
failed" in the Rules tab) on the next scan rather than a finding. That is the honest result: the
rule is counted as unknown, not as passing. Validate a pack rule before enabling it, and prefer
the ones whose query reads like the example above.

### The finding and the dashboard

A Basic-SKU load balancer becomes one high-severity finding in the reliability category, with the
resource id, name, tags and the two extra columns in evidence. On the dashboard it raises the
reliability category's failing count by one rule and the Severity Breakdown's high slice by one
finding.

## Example D: a Directory rule for expiring app secrets

**The standard:** no app registration should have a client secret expiring within 30 days
without someone knowing.

**Kind of check:** Directory objects (Microsoft Graph). This is the built-in **App Registration
Secret Expiring** rule (identity, enabled by default), one of the
<!-- count:credential-expiry-rules -->two credential-expiry rules. Its sibling does the same for
certificates (`keyCredentials`).

**Permission:** the Microsoft Graph application permission `Application.Read.All`, with admin
consent, on the same identity that scans Azure. That grant covers applications and service
principals only. See [`permissions.md`](permissions.md) and
[`directory-rules.md`](directory-rules.md#permissions).

### What you set in the form

| Field | Value |
|---|---|
| Resource type | Applications |
| Filter | (blank: every app registration) |
| Flag expiring items | on |
| Array field | `passwordCredentials` |
| Date field | `endDateTime` |
| Item id field | `keyId` |
| Item label | Client secret |
| Severity by days remaining | 7: critical, 14: high, 30: medium |

Press **Validate** and the editor shows how many app registrations the query matches, whether the
result was truncated, and up to five sample names. With `Application.Read.All` missing, Validate
returns a generic failure (the real Graph error is in the server log, never in the browser).

### The query RuleBeat runs

```
GET https://graph.microsoft.com/v1.0/applications?$select=id,displayName,passwordCredentials,appId
```

paged until done, with a 10,000-object cap that reports the rule as `capped` if it is hit. Each
credential's `endDateTime` is turned into days remaining (rounded up), the bands are checked
tightest first, and the first one the item falls under sets the severity. A secret that already
expired has negative days remaining and lands in the 7-day band: critical. A secret with 60 days
left is outside every band and is not a finding.

### The finding

Each expiring credential is its own finding, not the app registration:

| Field | Value |
|---|---|
| Title | App Registration Secret Expiring (the rule's name) |
| Resource | the app registration's display name |
| Resource id | `applications/<object id>/passwordCredentials/<keyId>` |
| Type | `microsoft.aad/applications/secrets` |
| Subscription | the first subscription id of the scanning identity (a directory object has none of its own) |
| Resource group, location, tags | empty |
| Severity | from the band: critical, high or medium |
| Evidence | the credential entry (`keyId`, `displayName`, `endDateTime`, ...) plus `daysRemaining` |
| Portal link | the app's **Certificates & secrets** blade, by `appId` |

Rotating one secret resolves exactly one finding on the next successful scan, because the
fingerprint includes the `keyId`. Two secrets on one app are two findings.

### On the dashboard

Directory findings sit in the identity category and flow through the same widgets, suppressions
and notifications as everything else. One thing to know: because they are attributed to the first
subscription, a dashboard filtered to a different subscription, or to a resource group, will not
show them. The identity category filter is the reliable way to look at them.

## Reading the four together

| | A: tag standard | B: HTTP storage | C: APRL load balancer | D: expiring secrets |
|---|---|---|---|---|
| Engine | Resource Graph | Resource Graph | Resource Graph | Microsoft Graph |
| Authored as | builder, with Applies to | raw KQL (built-in) | raw KQL (pack) | Directory form |
| Permission | Reader | Reader | Reader | `Application.Read.All` |
| One finding is | a VM | a storage account | a load balancer | one credential |
| Extra evidence | `tags` | `supportsHttpsTrafficOnly` | `recommendationId`, `Param1` | credential + `daysRemaining` |

All four share one lifecycle, one Scans page, one set of suppressions, one posture figure and one
notification path. That is the product: not the individual checks, which you will replace with your
own, but the fact that every check you write gets the same history and the same honesty about when
it could not run.
