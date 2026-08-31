# Directory rules

A Directory rule checks the directory itself (app registrations, service principals, users, groups)
rather than Azure resources. For the Resource configuration kind, see
[`authoring-rules.md`](authoring-rules.md).

Answer "What does this rule check?" with **Directory objects** and the rule runs against Microsoft
Graph, so it has no ARG scope or resource type filter. Everything else is the same as any other rule:
it lives in the Rules tab, runs in the same scans and schedules, and can be suppressed, dashboarded
and notified on. The two built-in credential-expiry checks are ordinary rules of this kind. They run
through their own engine because a directory object has no subscription, resource group or location
([`how-it-works.md`](how-it-works.md#two-engines-not-one-engine-with-a-branch)).

## The editor

| Field | What it does |
|---|---|
| **Resource type** | One of <!-- count:graph-resource-types -->seven object types: Users, Groups, Applications, Service principals, Directory roles, Devices, Administrative units. The list is an allowlist enforced server-side. |
| **Filter** | An optional OData `$filter`, for example `accountEnabled eq false`. Blank matches every object of that type. |
| **Validate** | Runs the query now and shows the match count, whether the result was truncated, and up to five sample rows. A malformed filter returns Graph's own error text; any other failure returns a generic one, with the real error in the server log. |
| **Flag expiring items** | Off by default. Turn it on when the check is about items nested inside each object rather than the object itself. |

Every object returned becomes one finding. Its resource type is `microsoft.graph/<type>`, its id is
`<type>/<object id>`, its name is the display name, and the whole returned object is stored as
evidence.

Graph is stricter than Resource Graph about which properties are filterable and which operators each
supports, so use Validate. Three filters covering the shapes most rules need:

```
accountEnabled eq false
```
On **Users** or **Devices**: every disabled account or device.

```
servicePrincipalType eq 'Application' and accountEnabled eq true
```
On **Service principals**: enabled service principals backed by an app registration, the population
you would review for unused or over-permissioned automation identities.

```
securityEnabled eq true and mailEnabled eq false
```
On **Groups**: security groups only, excluding Microsoft 365 groups and distribution lists.

## Flag expiring items

An app registration has a `passwordCredentials` array where each entry has an `endDateTime`. Turn
this on and the rule stops treating the app registration as the finding and starts treating each
credential as one.

| Field | Example (the built-in app secrets rule) |
|---|---|
| Array field | `passwordCredentials` |
| Date field | `endDateTime` |
| Item id field | `keyId` |
| Item label | Client secret |
| Severity by days remaining | 7 days: critical, 14 days: high, 30 days: medium |

Days remaining are rounded up, so "expires later today" reads as 1 day, and bands are checked
tightest first. An item outside every band produces no finding. An item already in the past has
negative days remaining and so falls under the tightest band, making an expired secret critical under
the defaults.

Each flagged item is its own finding with its own fingerprint, so one app registration with three
expiring secrets is three findings and rotating one resolves exactly one. Evidence is the credential
entry plus `daysRemaining`. App registration findings link straight to that app's Certificates &
secrets blade; other object types have no verified deep link, so they get none rather than a guess.

## Permissions

Directory rules need a Microsoft Graph **application** permission on the same identity that scans
Azure, with admin consent:

| Object type | Read permission it needs |
|---|---|
| Applications, Service principals | `Application.Read.All` |
| Users | `User.Read.All` |
| Groups | `Group.Read.All` |
| Directory roles | `RoleManagement.Read.Directory` |
| Devices | `Device.Read.All` |
| Administrative units | `AdministrativeUnit.Read.All` |

`Directory.Read.All` covers all of them in one grant, at the cost of being broader than most checks
need. A few properties carry their own requirement beyond the object type's, so confirm against
Microsoft's Graph permissions reference before granting. All of these are read permissions; RuleBeat
never requests a write permission on Graph.

The documented setup ([`permissions.md`](permissions.md)) grants `Application.Read.All` only. With
it, Applications and Service principals rules work and the other five types return a Graph
authorization error, reported as a `failed` outcome on that rule alone. Skip the grant and every
Directory rule is skipped. The onboarding wizard and Diagnostics probe `/v1.0/applications`, so that
check covers `Application.Read.All` specifically and not the others.

## How Directory findings behave

Lifecycle, suppressions, dashboards, notifications and export are identical to Resource Graph
findings. Four differences: a directory object has no subscription, so a Directory finding is
recorded under the first subscription id of the scanning identity and a dashboard filtered to a
different subscription will not show it; Applies to is not available, so the finding count is the
whole story; more than 10,000 objects is reported as `capped` rather than silently cut; and location,
resource group and tags are empty, being ARM concepts, so filtering a dashboard by resource group or
tag excludes Directory findings by construction.

They also cannot query any Graph path outside the seven allowlisted types (no sign-in logs, no audit
logs, no conditional access policies; adding a type is a code change, by design), join two object
types or filter on a relationship, or express anything `$filter` cannot, since there is no
client-side evaluation after the query.
