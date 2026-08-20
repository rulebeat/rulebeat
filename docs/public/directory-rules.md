# Directory rules

This page answers: how do I write a rule about the directory itself (app registrations, service
principals, users, groups) rather than about Azure resources, what can it see, and which permission
does it need? For the Resource configuration kind of rule, see
[`authoring-rules.md`](authoring-rules.md).

## What a Directory rule is

When you create a rule and answer "What does this rule check?" with **Directory objects**, the
rule runs against Microsoft Graph instead of Azure Resource Graph. The editor says so at the top:
this is a directory object, not an Azure resource, so there is no ARG scope or resource type filter
here. Everything after that point is the same as any other rule: it lives in the Rules tab, runs in
the same scans and schedules, produces findings with the same lifecycle, and can be suppressed,
dashboarded and notified on. The two built-in credential-expiry checks (expiring app secrets,
expiring app certificates) are ordinary rules of this kind, not special cases.

Directory rules run through their own engine (`packages/core/src/engine/graph-runner.ts`), separate
from the Resource Graph one, because a directory object has no subscription, resource group or
location. See [`how-it-works.md`](how-it-works.md#two-engines-not-one-engine-with-a-branch).

## The editor

| Field | What it does |
|---|---|
| **Resource type** | One of <!-- count:graph-resource-types -->seven object types: Users, Groups, Applications, Service principals, Directory roles, Devices, Administrative units. This list is an allowlist enforced server-side; a saved rule cannot point at any other Graph path. |
| **Filter** | An optional OData `$filter` expression, for example `accountEnabled eq false`. Leave it blank to match every object of that type. |
| **Validate** | Runs the query now, against your connected identity, and shows the match count, whether the result was truncated, and up to five sample rows (display name and id). A malformed filter comes back as Graph's own error text so you can fix it; any other failure (a missing permission, for instance) comes back as a generic message, with the real error in the server log, so a browser never sees tenant or identity details. |
| **Flag expiring items** | Off by default. Turn it on when the check is about items nested inside each object (credentials on an app registration) rather than the object itself. See below. |

Every object the query returns becomes one finding, exactly as every row from a Resource Graph
query does. The finding's resource type is `microsoft.graph/<type>`, its id is `<type>/<object id>`,
its name is the object's display name, and the whole returned object is stored as the finding's
evidence.

## Three real filters

Graph's OData filter grammar is documented by Microsoft; these three are the shapes most rules need.

```
accountEnabled eq false
```
On **Users** or **Devices**: every disabled account or device. Useful as a hygiene check
("disabled accounts older than the retention policy still exist") when paired with a review cadence.

```
servicePrincipalType eq 'Application' and accountEnabled eq true
```
On **Service principals**: every enabled service principal backed by an application registration,
the population you would review for unused or over-permissioned automation identities.

```
securityEnabled eq true and mailEnabled eq false
```
On **Groups**: security groups only, excluding Microsoft 365 groups and distribution lists.

Graph is stricter than Resource Graph about which properties are filterable and which operators
each one supports. Use Validate; it will tell you immediately if a filter is rejected, and the count
it returns is what the rule will produce as findings.

## Flag expiring items

Some checks are really about items inside each object. An app registration has a `passwordCredentials`
array; each entry has an `endDateTime`. Turn on **Flag expiring items** and the rule stops treating
the app registration as the finding and starts treating each credential as one.

| Field | Example (the built-in app secrets rule) |
|---|---|
| Array field | `passwordCredentials` |
| Date field | `endDateTime` |
| Item id field | `keyId` |
| Item label | Client secret |
| Severity by days remaining | 7 days: critical, 14 days: high, 30 days: medium |

How a band is chosen: the days remaining until the date field is computed (rounded up, so "expires
later today" reads as 1 day), then the bands are checked in the order you listed them, tightest
first; the first band whose "days" the item falls under sets the severity. An item outside every
band produces no finding. An item whose date is already in the past has negative days remaining,
so it falls under the tightest band: an expired secret that was never removed is a critical finding
under the defaults, which is the right answer.

Each flagged item is its own finding with its own fingerprint, so one app registration with three
expiring secrets is three findings, and rotating one of them resolves exactly one. The finding's
evidence is the credential entry plus `daysRemaining`. For app registrations specifically, the
finding also carries a link straight to that app's Certificates & secrets blade in the Azure
portal; other object types have no verified deep link, so they get none rather than a guess.

## Permissions

Directory rules need a Microsoft Graph **application** permission granted to the same identity that
scans Azure, with admin consent. Which permission depends on the object type:

| Object type | Read permission it needs |
|---|---|
| Applications, Service principals | `Application.Read.All` (the grant RuleBeat's docs and onboarding describe) |
| Users | `User.Read.All` |
| Groups | `Group.Read.All` |
| Directory roles | `RoleManagement.Read.Directory` |
| Devices | `Device.Read.All` |
| Administrative units | `AdministrativeUnit.Read.All` |

`Directory.Read.All` covers all of them in one grant, at the cost of being broader than most
checks need. Confirm the exact permission for the property you are filtering on against Microsoft's
Graph permissions reference before granting it; the table above names the read permission for the
object type, and a few properties (for example, some user attributes) carry their own requirement.
All of these are read permissions. RuleBeat never requests or uses a write permission on Graph.

The documented setup ([`permissions.md`](permissions.md)) grants `Application.Read.All` only. With
that grant, Applications and Service principals rules work and the other five object types return a
Graph authorization error, which the rule reports as a `failed` outcome ("query failed" in the Rules
tab) without affecting any other rule in the scan. Skip the grant entirely and every Directory rule
is simply skipped; nothing else in the product is affected.

The onboarding wizard and the Diagnostics page include a check named **Microsoft Graph (directory
rules)** that probes `/v1.0/applications` with a one-item page and reports pass, or a warning with
the text of the missing grant. It checks `Application.Read.All` specifically, because that is what
the two built-in rules need; it does not probe the other permissions.

## How Directory findings behave

- **Lifecycle.** Same as every finding: a fingerprint of `ruleId::resourceId`, seen again on each
  scan, marked fixed only when the rule's run succeeded and the object (or item) did not reappear.
- **Suppressions, dashboards, notifications, export.** Identical to Resource Graph findings.
- **Subscription.** A directory object has no subscription. So that it fits in the same findings
  table and the same widgets, a Directory finding is recorded under the first subscription id of
  the scanning identity. A dashboard filtered to a different subscription will not show it.
- **Applies to.** Not available for Directory rules. The finding count is the whole story.
- **Truncation.** A Graph query that returns more than 10,000 objects is reported as `capped`
  rather than silently cut, so the rule's earlier findings are kept and the Rules tab shows "result
  capped".
- **Location, resource group, tags.** Empty; these are ARM concepts. Filtering a dashboard by
  resource group or tag excludes Directory findings by construction.

## What Directory rules cannot do today

- Query any Graph path outside the seven allowlisted types (no sign-in logs, no audit logs, no
  conditional access policies). Adding a type is a code change to the allowlist, by design.
- Join two object types, or filter on a relationship (members of a group, owners of an app). Each
  rule reads one collection.
- Express anything Graph's `$filter` cannot. There is no client-side evaluation after the query.
