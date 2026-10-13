# Mirroring Azure role assignments through ARM: primary-source research

This note answers issue #256. The plan is to scope what each RuleBeat user can see by mirroring the
Azure role assignments held by an Azure account that an admin links to that user. That account may
not be the one the user signs in with (for example, a separate admin account). RuleBeat scans with
one shared Reader credential and never uses the signed-in user's token, so the mirror has to be
built from Azure Resource Manager (ARM) with that credential, with no Microsoft Graph permission.

Every claim below cites a Microsoft-owned page (Microsoft Learn or an official REST reference).
Anything a primary source does not state is labelled **Inference**. Anything that needs a real
tenant to settle is labelled **Live test** with an id (T1, T2, ...) from the list in section 9.

## Answer in short

- **Group-inherited assignments can be resolved through ARM alone.** The role assignments list API
  filter `$filter=assignedTo('{objectId}')` returns assignments made to the principal and to every
  group it belongs to, transitively through nested groups. It accepts only a user or service
  principal object id, never a group id
  ([List role assignments using the REST API](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-list-rest)).
  No document says the caller needs a Graph permission for it; the only documented permission is
  `Microsoft.Authorization/roleAssignments/read`, which Reader has (Live test T2).
- **Resource Graph's `authorizationresources` table does not expand groups.** Its rows are raw
  assignments keyed by `principalId`, and it has no PIM eligibility and no deny assignments
  ([supported tables](https://learn.microsoft.com/en-us/azure/governance/resource-graph/reference/supported-tables-resources)).
  Using it would need Graph to resolve group membership, which breaks the constraint. Use ARM REST.
- **Reader can read role assignments**, because Reader is `*/read` and listing needs only
  `Microsoft.Authorization/roleAssignments/read`
  ([Reader role](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/general),
  [list in the portal](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-list-portal)).
  The mirror can only see what that credential can read, so RuleBeat's Reader should sit at the
  tenant root management group or on every scope in use.
- **The docs disagree about which scopes one call returns.** One page says `atScope()` returns
  only the given scope; the REST reference says "at or above". Neither page documents what
  `assignedTo()` alone returns above and below a subscription, and a hint in the portal docs
  suggests listing at management group scope does not return child assignments (Live tests T3, T4).
  The safe design is one `assignedTo()` call per subscription plus one per management group, and
  merging the results.
- **PIM-eligible assignments are a separate API** (`roleEligibilityScheduleInstances`), which also
  supports `assignedTo()`. They are not in the plain role assignments list. Eligible group
  membership through PIM for Groups lives in Entra and is probably invisible to ARM (Live test T6).
- **Deny assignments are a separate API** with the same `assignedTo()` filter. Today they are
  almost all created by Azure itself, and they can target "All principals" with exclusions.
- **A role on a single resource means that resource and its child resources only**, not its
  resource group or its siblings
  ([scope overview](https://learn.microsoft.com/en-us/azure/role-based-access-control/scope-overview)).
- **The linked account has to be entered as an object id.** Turning a sign-in name into an object
  id is a Graph lookup, and the ARM filters accept only object ids. A B2B guest's id is the guest
  object in the resource tenant.
- **Classic administrators no longer need handling.** They were converted to ordinary Owner
  assignments at subscription scope and are fully retired as of May 2026. Lighthouse delegations
  are not shown by the role assignments API at all.
- **Refresh hourly plus on demand.** ARM read limits allow far more than that. Azure itself can
  take up to 10 minutes to apply a role change, so polling much faster than that buys little.

## 1. What the role assignments API returns for one object id

### The filters

The REST how-to lists the request as
`GET https://management.azure.com/{scope}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$filter={filter}`
and gives four filters
([List role assignments using the REST API](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-list-rest)):

| Filter | What the page says it returns |
|---|---|
| `atScope()` | "role assignments for only the specified scope, not including the role assignments at subscopes" |
| `assignedTo('{objectId}')` | "role assignments for a specified user or service principal. If the user is a member of a group that has a role assignment, that role assignment is also listed. This filter is transitive for groups ... This filter only accepts an object ID for a user or a service principal. You cannot pass an object ID for a group." |
| `atScope()+and+assignedTo('{objectId}')` | "role assignments for the specified user or service principal and at the specified scope" |
| `principalId+eq+'{objectId}'` | "role assignments for a specified user, group, or service principal" (direct assignments only; no group expansion is described) |

The same page needs api-version `2015-07-01` or later, and `2022-04-01` or later for the
assignment's `condition` to be included. Its scope table lists four scope forms: management group
(`providers/Microsoft.Management/managementGroups/{groupId}`), subscription, resource group and
resource. Each returned assignment carries `principalId`, `principalType`, `scope`,
`roleDefinitionId`, `condition` and `delegatedManagedIdentityResourceId`, among others.

The REST reference adds the permission (`Microsoft.Authorization/roleAssignments/read`), the
`principalType` values (`User`, `Group`, `ServicePrincipal`, `ForeignGroup`, `Device`, `AgentUser`,
`AgentServicePrincipal`), a `nextLink` for paging, and a `tenantId` parameter for cross-tenant
requests. It describes only `atScope()` and `principalId eq`, and never mentions `assignedTo()`
([Role Assignments - List For Scope](https://learn.microsoft.com/en-us/rest/api/authorization/role-assignments/list-for-scope),
[List For Subscription](https://learn.microsoft.com/en-us/rest/api/authorization/role-assignments/list-for-subscription)).
`assignedTo()` is documented only on the how-to page above, on the PIM pages (section 3) and on the
deny assignments page (section 4).

### Group expansion

`assignedTo()` is the one filter that expands groups. It is transitive, so nested groups are
covered, and it accepts a user or service principal id only (same page as above). The CLI and
PowerShell expose the same behaviour: `az role assignment list --include-groups` "Include[s] extra
assignments to the groups of which the user is a member (transitively)"
([az role assignment](https://learn.microsoft.com/en-us/cli/azure/role/assignment)), and
`Get-AzRoleAssignment -ExpandPrincipalGroups` "returns roles directly assigned to the user and to
the groups of which the user is a member (transitively). Supported only for a user principal"
([Get-AzRoleAssignment](https://learn.microsoft.com/en-us/powershell/module/az.resources/get-azroleassignment)).
The PowerShell page says "supported only for a user principal" while the REST page also allows a
service principal. For RuleBeat the linked account is a person, so this does not matter.

What the page does not say: which group a returned row came through. The example output shows a
direct assignment with `principalType: User`. **Inference:** a group-inherited row carries the
group's id as `principalId` and `principalType: Group`, because that is the assignment object that
exists; ARM has no field naming the member that matched. RuleBeat can show "via a group" but not
which nesting path, without Graph (Live test T1).

### Does group expansion need a Graph permission?

No page says it does. The how-to and the REST reference name only
`Microsoft.Authorization/roleAssignments/read`. The tools are explicit about which of their own
features call Graph, and group expansion is not one of them:

- The CLI's `--fill-principal-name` is what queries Graph, "to get the assignee's
  userPrincipalName ... or displayName"; its example with `--assignee-object-id` and
  `--fill-principal-name false` "does not query Microsoft Graph"
  ([az role assignment](https://learn.microsoft.com/en-us/cli/azure/role/assignment)).
- PowerShell lists the Graph calls it may make (`/users/{id}`, `/servicePrincipals/{id}`,
  `/groups/{id}`, `/directoryObjects/{id}`, `/directoryObjects/getByIds`). Those calls fetch
  object details, and the cmdlet marks `ObjectType` as `Unknown` when "current account has
  insufficient privileges to get object type"
  ([Get-AzRoleAssignment](https://learn.microsoft.com/en-us/powershell/module/az.resources/get-azroleassignment)).
- The RBAC troubleshooting page puts the CLI's "Insufficient privileges" error on the assignee
  lookup by sign-in name, and fixes it with `--assignee-object-id`, which "will skip the Microsoft
  Entra lookup"
  ([Troubleshoot Azure RBAC](https://learn.microsoft.com/en-us/azure/role-based-access-control/troubleshooting)).

**Inference:** ARM expands the groups on the server side, using its own access to the directory, so
a Reader service principal with no Graph permission can call `assignedTo()`. This is the claim the
plan most depends on, so it is Live test T2.

### Which scopes one call covers

This is where the docs are ambiguous.

- The how-to says `atScope()` returns "only the specified scope, not including the role
  assignments at subscopes"
  ([how-to](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-list-rest)).
- The REST reference says "Use $filter=atScope() to return all role assignments at or above the
  scope. Use $filter=principalId eq {id} to return all role assignments at, above or below the
  scope for the specified principal"
  ([List For Scope](https://learn.microsoft.com/en-us/rest/api/authorization/role-assignments/list-for-scope)).
- PowerShell's `-Scope` "will filter assignments that are effective at that particular scope i.e.
  all assignments at that scope and above"
  ([Get-AzRoleAssignment](https://learn.microsoft.com/en-us/powershell/module/az.resources/get-azroleassignment)).
- The CLI separates `--include-inherited` ("Include assignments applied on parent scopes") from
  `--all` ("Show all assignments under the current subscription"), which suggests parent scopes
  and child scopes are separate concerns in the API
  ([az role assignment](https://learn.microsoft.com/en-us/cli/azure/role/assignment)).

Both readings agree that `atScope()` excludes child scopes. They disagree on whether it includes
parent scopes. No page says what `assignedTo()` on its own returns above or below the scope it is
called at.

So: do not use `atScope()` for the mirror. Call `assignedTo()` alone at each subscription and
expect it to return assignments at the subscription, its resource groups and its resources, plus
anything inherited from management groups above. Then check that expectation (Live test T3).

### Management groups and the root scope

The how-to's scope table includes management group scope
([how-to](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-list-rest)).
In the portal's download of role assignments, the "Children" option "is disabled for management
group scope"
([list in the portal](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-list-portal)).
**Inference:** a listing at a management group returns that group and what sits above it, not the
subscriptions under it. So the mirror lists each subscription, and also each management group for
assignments made at management group scope. A management group holds at most 500 role assignments
([troubleshoot limits](https://learn.microsoft.com/en-us/azure/role-based-access-control/troubleshoot-limits)).
Live test T4.

Above the tenant root group sits the root scope `/`. The only assignment usually there is User
Access Administrator granted through elevated access (section 6). The elevated access page lists
assignments at `/` with `GET /providers/Microsoft.Authorization/roleAssignments` and
`$filter=principalId eq` or `atScope()`, as a Global Administrator who has elevated
([elevate access](https://learn.microsoft.com/en-us/azure/role-based-access-control/elevate-access-global-admin)).
The deny assignments page states that listing at root `/` requires elevated access
([deny assignments](https://learn.microsoft.com/en-us/azure/role-based-access-control/deny-assignments)).
Whether a Reader at the tenant root group can see `/`-scope role assignments, either directly or
as "above" a lower scope, is not documented (Live test T5).

### Can a Reader read every assignment, including inherited ones and those on resources?

Yes, within the Reader's own reach.

- Reader's only action is `*/read`, assignable at `/`
  ([Reader](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/general)).
  That covers `Microsoft.Authorization/roleAssignments/read`,
  `Microsoft.Authorization/denyAssignments/read` and the PIM schedule reads.
- The portal list page names the prerequisite as `roleAssignments/read`, "such as Reader"
  ([list in the portal](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-list-portal)).
  The PIM REST sample says this permission is one "All built-in roles are granted"
  ([PIM eligibility REST sample](https://learn.microsoft.com/en-us/rest/api/authorization/privileged-role-eligibility-rest-sample)).
- Permissions inherit downward: an assignment at a parent scope applies at every child scope
  ([scope overview](https://learn.microsoft.com/en-us/azure/role-based-access-control/scope-overview)).
  A Reader at the tenant root group can therefore read assignments on every management group,
  subscription, resource group and resource below it.
- Resource Graph queries "only return role assignments or custom roles that you have permissions to
  read"
  ([troubleshoot limits](https://learn.microsoft.com/en-us/azure/role-based-access-control/troubleshoot-limits)).
  The same holds for ARM: anything outside the credential's reach is invisible.

For RuleBeat this outcome is acceptable. A scope the credential cannot read also has no findings,
so missing assignments there hide nothing. The setup docs should still say that the Reader belongs
at the tenant root group if user scoping is turned on.

Display names are a separate matter. Without Directory Readers, the portal leaves `DisplayName`,
`SignInName` and `ObjectType` blank
([list in the portal](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-list-portal)).
The mirror needs ids only, but RuleBeat cannot show the names of the groups involved.

## 2. Resource Graph `authorizationresources`

The table holds three types: `microsoft.authorization/classicadministrators`,
`microsoft.authorization/roleassignments` and `microsoft.authorization/roledefinitions`
([supported tables](https://learn.microsoft.com/en-us/azure/governance/resource-graph/reference/supported-tables-resources),
[samples by table](https://learn.microsoft.com/en-us/azure/governance/resource-graph/samples/samples-by-table)).
Role assignment rows carry `properties.principalId`, `properties.principalType`,
`properties.scope` and `properties.roleDefinitionId`. Management group assignments can be picked
out with `id startswith "/providers/Microsoft.Management/managementGroups"`, and the queries check
active assignments only: the page says it "doesn't consider eligible role assignments" and points
to Role Eligibility Schedule Instances instead
([troubleshoot limits](https://learn.microsoft.com/en-us/azure/role-based-access-control/troubleshoot-limits)).
Resource Graph also notes that it "scrubs PII information"
([supported tables](https://learn.microsoft.com/en-us/azure/governance/resource-graph/reference/supported-tables-resources)).

There is no group expansion. To use this table, RuleBeat would need the user's transitive group ids
from Graph (`transitiveMemberOf`), which breaks the no-Graph constraint. The table also has no
eligibility and no deny assignments. It is useful for one thing: one query can return every
assignment in the tenant, so it can tell RuleBeat when something has changed. It cannot be the
source of the mirror.

## 3. PIM-eligible and time-bound assignments

- Eligible assignments come from a separate API, Role Eligibility Schedule Instances (api-version
  `2020-10-01`). It accepts `atScope()`, `principalId eq`, `assignedTo('{userId}')` and `asTarget()`.
  Each instance carries `status`, `memberType` (`Inherited`, `Direct` or `Group`), `startDateTime`,
  `endDateTime` and an `expandedProperties` block with display names
  ([Role Eligibility Schedule Instances - List For Scope](https://learn.microsoft.com/en-us/rest/api/authorization/role-eligibility-schedule-instances/list-for-scope)).
  The REST sample describes `assignedTo` as "List role assignments for a specified user, including
  ones inherited from groups". It also explains that schedules include future assignments while
  instances are the current ones only
  ([PIM eligibility REST sample](https://learn.microsoft.com/en-us/rest/api/authorization/privileged-role-eligibility-rest-sample)).
  The `memberType` value of `Group` is the one place ARM says an item came through a group.
  Whether `expandedProperties` is filled in for a caller with no Graph permission is not documented
  (Live test T7). The mirror does not need it.
- Active PIM assignments have their own instances API with `assignmentType` set to `Activated` or
  `Assigned`, and a `linkedRoleEligibilityScheduleInstanceId`
  ([Role Assignment Schedule Instances - List For Scope](https://learn.microsoft.com/en-us/rest/api/authorization/role-assignment-schedule-instances/list-for-scope)).
  **Inference:** an activated eligible role also shows up in the plain role assignments list while
  it is active, because activation creates a real role assignment. That list is then the right
  place to read active access, and a time-bound assignment drops out of it when it expires (Live
  test T8).
- Eligible assignments are for users only, not service principals or managed identities. They can
  be made from IAM at management group, subscription and resource group scope; resource-scope ones
  are made in PIM directly. They need a P2 or ID Governance licence
  ([PIM integration](https://learn.microsoft.com/en-us/azure/role-based-access-control/pim-integration)).
  With that licence, the IAM page shows a State column with Active and Eligible values, each either
  permanent or time-bound
  ([list in the portal](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-list-portal)).
- On meaning, Microsoft says "There's no difference in the access given to someone with a
  permanent versus an eligible role assignment"
  ([PIM integration](https://learn.microsoft.com/en-us/azure/role-based-access-control/pim-integration)).
  Someone eligible can activate at any moment. **Recommendation:** count eligible assignments as
  visibility, and record them as eligible so the UI can say so.
- Eligible assignments do not count toward the 5,000-per-subscription limit
  ([list in the portal](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-list-portal)).
- PIM for Groups makes membership of a group just-in-time, and a group can be an eligible member of
  another group
  ([PIM for Groups](https://learn.microsoft.com/en-us/entra/id-governance/privileged-identity-management/concept-pim-for-groups)).
  That eligibility lives in Entra, not in ARM. **Inference:** `assignedTo()` expands only active
  membership. A user who is only eligible for a group that holds an Azure role is invisible to the
  mirror until they activate. This is the one gap Graph would close (Live test T6).

## 4. Deny assignments

Deny assignments "block users from performing specific actions even if a role assignment grants
them access"
([role definitions](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-definitions)).
Most are created by Azure itself (for example by deployment stacks); deny assignments that
customers manage are in private preview. A deny assignment can target All Principals (an all-zeros
principal id of type `SystemDefined`) with an `ExcludePrincipals` list, and can be set not to apply
to child scopes. Listing needs `Microsoft.Authorization/denyAssignments/read`, "included in most
built-in roles". The filters mirror the role assignment ones: no filter returns at, above and below
the scope; `atScope()` returns the scope and above; `assignedTo()` is transitive for groups and
takes a user or service principal id only
([deny assignments](https://learn.microsoft.com/en-us/azure/role-based-access-control/deny-assignments)).
The REST reference adds `gdprExportPrincipalId`, which also matches a principal named in
`ExcludePrincipals`, and does not list `assignedTo()`
([Deny Assignments - List For Scope](https://learn.microsoft.com/en-us/rest/api/authorization/deny-assignments/list-for-scope)).

For a mirror that answers "what can this account see", a deny assignment only matters if its
actions include a read. **Recommendation:** fetch them with `assignedTo()`, store them, and
subtract a scope only when the denied actions cover a read. Do not assume either way.

## 5. Custom roles, and what a role at a scope means

### Custom roles and data-plane roles

A role definition has `actions`, `notActions`, `dataActions` and `notDataActions`. `notActions` is
"not a deny rule": a second role that grants the excluded action restores it
([role definitions](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-definitions)).
Custom roles appear as `roledefinitions` with `properties.type` of `CustomRole` and their own
`assignableScopes`, and a directory holds at most 5,000 of them
([troubleshoot limits](https://learn.microsoft.com/en-us/azure/role-based-access-control/troubleshoot-limits)).
An assignment row carries only `roleDefinitionId`, so the mirror has to read role definitions to
know what a custom role allows. Reader's `*/read` covers that.

Control-plane and data-plane access are separate. "If a user has a Reader role on a subscription,
then they can view the storage account, but by default they can't view the underlying data."
Storage Blob Data Reader has both a control-plane `containers/read` action and a data-plane
`blobs/read` data action
([role definitions](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-definitions)).
RuleBeat findings are about control-plane configuration, so only `actions` matter for visibility.

**Product decision:** either any role assignment at or above a resource counts as visibility
(simple, and it matches how people think about "having access"), or only roles whose effective
`actions` include a read. Nearly every built-in role has some read action, so the two give the same
answer in practice. The difference shows for narrow custom roles and data-only roles.

Role assignment conditions (ABAC) come back in the `condition` property with api-version
`2022-04-01`
([how-to](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-list-rest)).
**Inference:** the conditions in Microsoft's examples constrain data actions or role assignment
writes, not control-plane reads, so the mirror can store them without evaluating them.

### A role on a single resource

There are four levels (management group, subscription, resource group, resource). Lower levels
inherit from higher ones, and a resource scope can be a sub-resource, such as a blob container
under a storage account
([scope overview](https://learn.microsoft.com/en-us/azure/role-based-access-control/scope-overview)).
Inheritance runs downward only. So a role on one resource gives access to that resource and its
child resources. It gives nothing on the resource group, on sibling resources or on the
subscription.

For RuleBeat:

- A finding is visible to a user when its ARM resource id equals one of the user's assignment
  scopes or sits under one, compared by whole path segments without regard to case.
  **Inference:** the case-insensitive comparison follows from ARM ids being case-insensitive.
- A role on a sub-resource (a container) does not cover a finding on the parent resource (the
  storage account).
- Findings with no ARM resource id (Microsoft Graph rules, Log Analytics activity rules) have no
  scope to match. That needs its own product decision, for example admin and unscoped users only.
- If a resource is moved, an assignment made directly on it "isn't moved and becomes orphaned"
  ([troubleshooting](https://learn.microsoft.com/en-us/azure/role-based-access-control/troubleshooting)).
  The mirror sees this as access lost, which is correct.

## 6. What makes "mirror the ARM role assignments of object id X" wrong or incomplete

- **The id must be a user or service principal.** `assignedTo()` rejects group ids
  ([how-to](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-list-rest)).
  Linking a group is not possible this way.
- **An admin cannot pick the account by name without Graph.** Resolving a sign-in name to an object
  id is a directory lookup, which is why the CLI offers `--assignee-object-id` "to bypass
  Microsoft Graph query"
  ([az role assignment](https://learn.microsoft.com/en-us/cli/azure/role/assignment)). The admin
  pastes the object id. RuleBeat cannot check that the id exists or what type it is. **Inference:**
  an unknown id returns an empty list rather than an error, so the UI must show "no Azure access
  found" and never fall back to showing everything (Live test T9).
- **B2B guests.** A guest is invited into the resource directory and assigned roles there like a
  member
  ([external users](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-external-users)).
  **Inference:** the id to link is the guest object's id in the resource tenant, not the person's
  id in their home tenant. The page does not say this directly (Live test T10).
- **Elevated access.** A Global Administrator who turns on "Access management for Azure resources"
  gets User Access Administrator at root scope `/`. By default Azure roles and Entra roles "don't
  span Azure and Microsoft Entra ID", and a Global Administrator "doesn't have access to Azure
  resources"
  ([Azure roles and Entra roles](https://learn.microsoft.com/en-us/azure/role-based-access-control/rbac-and-directory-admin-roles),
  [elevate access](https://learn.microsoft.com/en-us/azure/role-based-access-control/elevate-access-global-admin)).
  User Access Administrator includes `*/read`, so an elevated admin can read everything. The mirror
  should treat an assignment at `/` as covering the whole tenant, if it can see one (Live test T5).
  Entra directory roles themselves never appear in ARM.
- **Classic administrators.** Retired on 31 August 2024. From December 2025 Azure assigned Owner at
  subscription scope to remaining Co-Administrators and Service Administrators, and as of May 2026
  the roles are fully retired
  ([classic administrators](https://learn.microsoft.com/en-us/azure/role-based-access-control/classic-administrators),
  [troubleshooting](https://learn.microsoft.com/en-us/azure/role-based-access-control/troubleshooting)).
  They now show up as ordinary Owner assignments. The portal list leaves them out
  ([list in the portal](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-list-portal)),
  and `-IncludeClassicAdministrators` and the Resource Graph `classicadministrators` type are
  legacy.
- **Lighthouse.** Role assignments authorized by a service provider through Azure Lighthouse
  "won't be shown"
  ([how-to](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-list-rest)).
  Delegations are registration definitions and registration assignments under
  `Microsoft.ManagedServices`, at subscription or resource group scope, that grant principals in
  the managing tenant
  ([Lighthouse architecture](https://learn.microsoft.com/en-us/azure/lighthouse/concepts/architecture)).
  A linked account from a managing tenant would mirror as no access. Out of scope for a first cut.
- **Nested groups.** Covered by `assignedTo()`. Groups the user is only eligible for through PIM
  for Groups are not (section 3).
- **Deleted principals.** An assignment to a deleted principal stays and is listed as "Identity not
  found"
  ([troubleshooting](https://learn.microsoft.com/en-us/azure/role-based-access-control/troubleshooting)).
  This only matters if the linked account itself is deleted, in which case the mirror correctly
  becomes empty.
- **Managed identities in groups.** Changes to a managed identity's group or role membership can
  take several hours to apply because of a cache of around 24 hours
  ([troubleshooting](https://learn.microsoft.com/en-us/azure/role-based-access-control/troubleshooting)).
  This only matters if someone links a managed identity, which is not the intended use.
- **Subscription transfer.** Moving a subscription to another directory deletes its role
  assignments permanently
  ([troubleshooting](https://learn.microsoft.com/en-us/azure/role-based-access-control/troubleshooting)).
  The next refresh picks that up.
- **Access that is not RBAC.** Keys, SAS tokens and local authentication give data access outside
  RBAC
  ([role definitions](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-definitions)).
  This does not affect who can see a control-plane finding, so the mirror can ignore it.

## 7. Throttling and refresh interval

ARM throttles with a token bucket per region. For reads, the subscription bucket holds 250 and
refills at 25 a second, and the tenant bucket is the same. Limits apply per subscription per
service principal, with a global limit 15 times higher across all principals. A `429` carries
`Retry-After`, and every response reports `x-ms-ratelimit-remaining-subscription-reads` or
`x-ms-ratelimit-remaining-tenant-reads`
([ARM request limits](https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/request-limits-and-throttling)).
**Inference:** management group and root scope calls count against the tenant bucket, and
subscription calls against that subscription's bucket.

Resource Graph has its own quota, for example 15 queries per 5-second window per user, "subject to
change", with `x-ms-user-quota-remaining` and `x-ms-user-quota-resets-after` headers. Each 1,000-row
page costs one unit
([Resource Graph throttling](https://learn.microsoft.com/en-us/azure/governance/resource-graph/concepts/guidance-for-throttled-requests)).
That matters only if Resource Graph is used for change detection, and it shares the quota with
RuleBeat's scans.

A full refresh for one linked account is roughly, per subscription, one `assignedTo()` call for
role assignments, one for eligibility instances and one for deny assignments, plus one role
assignment call per management group, plus paging. With 50 linked accounts and 100 subscriptions
that is about 150 reads per subscription per refresh, under one full bucket. Role definitions are
shared across users and can be cached separately.

Azure itself caches: a role change "can take up to 10 minutes" to take effect, and so can a new
child management group inheriting its parent's assignments
([troubleshooting](https://learn.microsoft.com/en-us/azure/role-based-access-control/troubleshooting)).

**Recommendation (a judgement, not a documented figure):** refresh every linked account hourly,
and also on demand when an admin links or changes an account and from a "Refresh access" button.
Back off on `Retry-After` and on the remaining-reads headers. Keep the last good mirror with its
timestamp if a refresh fails, and stop showing anything to that user if the mirror is older than
an agreed maximum. Failing closed matches the read-only, least-surprise stance.

## 8. Recommended approach

1. Store, for each RuleBeat user, the linked object id (pasted by an admin, or the `oid` from
   Entra sign-in when the linked account is the sign-in account).
2. On each refresh, for every subscription the credential can see, call
   `/subscriptions/{id}/providers/Microsoft.Authorization/roleAssignments?$filter=assignedTo('{oid}')`,
   the eligibility instances API with the same filter, and the deny assignments API with the same
   filter. For every management group, call the role assignments list with `assignedTo('{oid}')`.
   Use `2022-04-01` and follow `nextLink`.
3. Merge by assignment id, keep each assignment's `scope`, role definition, `principalType`
   (direct or via group) and whether it is active or eligible.
4. A finding is visible when its resource id sits at or under any stored scope, after subtracting
   scopes where a read-covering deny assignment applies. A scope of `/` or of the tenant root group
   means everything.
5. Never fall back to "show everything" on an empty or failed mirror.

## 9. Live tenant tests

Run each with a Reader service principal (at the tenant root group) that has no Microsoft Graph
permission and no Entra directory role.

| Id | Test | Why it matters |
|---|---|---|
| T1 | Give a user a role only through a group. Call `assignedTo()`. Check `principalId` and `principalType` on the returned row. | Whether RuleBeat can say "via a group" |
| T2 | Same setup, with the group nested two levels deep. Confirm `assignedTo()` returns it with no Graph permission on the caller. | The whole plan depends on it |
| T3 | Make assignments for the user at management group, subscription, resource group and resource scope. Call `assignedTo()` alone at the subscription. Record which come back. | Which calls the mirror needs |
| T4 | Call `assignedTo()` at a management group. Check whether assignments on child subscriptions come back. | Whether per-subscription calls are needed |
| T5 | Elevate a Global Administrator. Check whether the Reader sees the `/`-scope User Access Administrator assignment, at `/` or as "above" a subscription. | Whether elevated access can be mirrored |
| T6 | Make a user eligible (PIM for Groups) for a group that holds an Azure role. Check `assignedTo()` before and after activation. | Size of the PIM for Groups gap |
| T7 | Check whether `expandedProperties` on eligibility instances is filled in for the Graph-less Reader. | UI copy only |
| T8 | Activate an eligible role. Check it appears in the plain role assignments list and disappears when it ends. | Whether eligible and active need separate handling |
| T9 | Call `assignedTo()` with a random id and with a group id. Record the response for each. | Error handling and copy |
| T10 | Invite a B2B guest, assign a role, and call `assignedTo()` with the guest object id and with the home-tenant id. | Which id the admin must paste |

## Sources

- [List Azure role assignments using the REST API](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-list-rest)
- [Role Assignments - List For Scope](https://learn.microsoft.com/en-us/rest/api/authorization/role-assignments/list-for-scope)
- [Role Assignments - List For Subscription](https://learn.microsoft.com/en-us/rest/api/authorization/role-assignments/list-for-subscription)
- [List Azure role assignments using the Azure portal](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-list-portal)
- [Understand scope for Azure RBAC](https://learn.microsoft.com/en-us/azure/role-based-access-control/scope-overview)
- [Understand Azure role definitions](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-definitions)
- [Azure built-in roles: General (Reader)](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/general)
- [Troubleshoot Azure RBAC limits](https://learn.microsoft.com/en-us/azure/role-based-access-control/troubleshoot-limits)
- [Troubleshoot Azure RBAC](https://learn.microsoft.com/en-us/azure/role-based-access-control/troubleshooting)
- [Resource Graph supported tables](https://learn.microsoft.com/en-us/azure/governance/resource-graph/reference/supported-tables-resources)
- [Resource Graph samples by table](https://learn.microsoft.com/en-us/azure/governance/resource-graph/samples/samples-by-table)
- [Resource Graph guidance for throttled requests](https://learn.microsoft.com/en-us/azure/governance/resource-graph/concepts/guidance-for-throttled-requests)
- [Role Eligibility Schedule Instances - List For Scope](https://learn.microsoft.com/en-us/rest/api/authorization/role-eligibility-schedule-instances/list-for-scope)
- [Role Assignment Schedule Instances - List For Scope](https://learn.microsoft.com/en-us/rest/api/authorization/role-assignment-schedule-instances/list-for-scope)
- [List eligible assignments using the REST API (PIM sample)](https://learn.microsoft.com/en-us/rest/api/authorization/privileged-role-eligibility-rest-sample)
- [Eligible and time-bound role assignments in Azure RBAC](https://learn.microsoft.com/en-us/azure/role-based-access-control/pim-integration)
- [Privileged Identity Management for Groups](https://learn.microsoft.com/en-us/entra/id-governance/privileged-identity-management/concept-pim-for-groups)
- [Understand Azure deny assignments](https://learn.microsoft.com/en-us/azure/role-based-access-control/deny-assignments)
- [Deny Assignments - List For Scope](https://learn.microsoft.com/en-us/rest/api/authorization/deny-assignments/list-for-scope)
- [Elevate access to manage all Azure subscriptions and management groups](https://learn.microsoft.com/en-us/azure/role-based-access-control/elevate-access-global-admin)
- [Azure roles, Microsoft Entra roles, and classic subscription administrator roles](https://learn.microsoft.com/en-us/azure/role-based-access-control/rbac-and-directory-admin-roles)
- [Azure classic subscription administrators](https://learn.microsoft.com/en-us/azure/role-based-access-control/classic-administrators)
- [Assign Azure roles to external guest users](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-external-users)
- [Azure Lighthouse architecture](https://learn.microsoft.com/en-us/azure/lighthouse/concepts/architecture)
- [Understand how Azure Resource Manager throttles requests](https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/request-limits-and-throttling)
- [az role assignment (Azure CLI)](https://learn.microsoft.com/en-us/cli/azure/role/assignment)
- [Get-AzRoleAssignment (Azure PowerShell)](https://learn.microsoft.com/en-us/powershell/module/az.resources/get-azroleassignment)
