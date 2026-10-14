# Access

A person's access in RuleBeat is a set of Roles, each held at a Scope. The Role says what they can do.
The Scope says where. This page is for the Admins who grant access and for the people who receive it.
The Roles themselves, and the action each one allows, are in [Roles and permissions](rbac.md).

## Roles at Scopes

A Scope is one of:

| Scope | What it covers |
|---|---|
| Everything | The whole install: every subscription and management group, including ones created later, and the Directory. |
| The Directory | Microsoft Graph findings, such as expiring app secrets and certificates. It carries no subscription. |
| A management group | Every subscription under it at any depth, and the findings placed at the group or at a group beneath it. A subscription added later is covered after the next hourly read of the management group tree. |
| A subscription | The resource groups in it, findings at the subscription itself, and the Log Analytics workspaces in it. |
| A resource group | Its own resources and its own workspaces. |

There are no resource-level Scopes. The smallest Scope is a resource group, since someone who looks
after one virtual machine looks at its resource group.

Overlapping Scopes add up: a person who holds a subscription and a resource group in another
subscription sees both, and where two Roles reach the same place the higher Role wins. Every Scope
is stored under the Azure tenant RuleBeat is connected to, so a subscription, a resource group or the
Directory cannot be given before Azure is connected.

An Admin is never scoped. An Admin holds Everything and is not given rows to narrow. Only Admins grant
access, and there are no delegated Admins for one subscription or management group, because an Admin
who manages people could widen their own Scope.

Everything is its own choice in the picker. It is not the same as selecting every management group,
which would miss what is created later.

## Mirrored and Manual access

An Admin gives each Viewer and Editor their access one of two ways. A person has one or the other,
never both, so a refresh never has to decide which list wins.

### Manual access

The Admin picks Scopes by hand, each with its own Role. Choose them on the **Access** page when adding
someone, with **Edit** beside a person, or when demoting an Admin, where Everything is preselected.
Adding a Viewer or Editor needs at least one Scope. Manual access is the only way to give Everything or
the Directory.

### Mirrored access

The Admin picks one Role and a **Linked account**: an Azure object id, which may be a different
account from the one the person signs in with. RuleBeat reads that account's Azure role assignments
with its own Reader credential and turns them into Scopes.

- Active assignments and PIM-eligible ones both count, whether held directly or through a group.
- An assignment on a single resource gives that resource's resource group.
- A role at the tenant root management group gives that management group. A mirror never gives
  Everything or the Directory.
- Deny assignments are ignored.
- The Azure role never decides the RuleBeat Role. Azure Contributor means "can change Azure
  resources"; RuleBeat Editor means "can write rules, schedules and suppressions". The Admin chooses the Role.

Saving shows the Scopes the account would give, and the Manual Scopes they hold that would be
replaced, before **Confirm**. "Use their sign-in account" fills the object id for a person who signed
in with Entra, when sign-in uses the same tenant as the Azure connection.

**When it refreshes.** About once an hour, after the management group tree is read; in the background
each time the person signs in, which never waits for it; and on demand with the **Refresh** button
beside each mirrored person. Automatic refreshes write no audit entry.

**When a refresh fails.** The last Scopes are kept, a stable reason is recorded (never Azure's own
text), and the Access page says the refresh failed, when, and that the Scopes shown are the last ones
that loaded.

**When there are no assignments.** A refresh that succeeds and finds none gives the person no Scope.
They see a message that they have been given no access and to ask an Admin, in place of "No findings
yet", and the Access page says why.

**Editing by hand.** Changing a mirrored person's Scopes by hand turns them into Manual access with the
same Scopes, so the mirror never overwrites a hand-made change. Changing their Role keeps the mirror
on. Switching back to mirrored replaces the Manual list after a confirmation.

For the mirror and the management group tree to see anything, the Reader credential has to be able to
read it. Grant Reader at the tenant root management group: see [Azure permissions](permissions.md#2-grant-reader).

## Where a finding sits

Each finding records where it sits, and a person sees it when a Scope they hold contains that place.

| The finding | It sits at |
|---|---|
| A Resource Graph finding | Its resource, or the subscription or management group a row names. A person with one resource group does not see a finding on the subscription above it. |
| A Microsoft Graph finding | The Directory. |
| A Log Analytics finding | The workspace it came from, so a Scope covering the workspace's resource group sees it. |
| A finding RuleBeat could not place | Nowhere. It is seen under Everything only. |

This narrows every list, count, filter option, column option, export and finding detail on the
Results, Advisories and Activity tabs, the dashboards, saved views, suppressions and Run History. A
saved view or dashboard filtered to something outside a person's access still opens: the filter
reads "Outside your access" and can be cleared.

## What a scoped Editor can do

An Editor whose Scopes fall short of Everything works inside them.

- **Run now** covers the overlap of each shared rule's own scope and the Editor's access. A rule with no
  overlap is not run, counted or made partial, and the run marks findings fixed only inside what it
  covered. Run History records the Scope of each run. See [Run history](scans-and-schedules.md#run-history).
- **Suppress** a finding that sits inside a Scope where they are an Editor. Anything else answers "Not found".
- **Personal rules** need a subscription or management group, and are seen and run only by their author.
  See [Personal rules](personal-rules.md).
- **Library, rule, schedule and category writes are switched off**, each control with the reason beside
  it. Those change what the whole install shares, so they need an Admin or an Editor on Everything.
  A mirrored Editor never holds Everything, even with a role at the tenant root, so they do not write
  the Library either. An Admin who wants someone to write the Library grants them Everything by hand.

A person whose access is only resource groups cannot write a query or a Personal rule, because
Resource Graph cannot limit a request to a resource group. They still see findings, suppress them and
run shared rules, whose rows are filtered to their resource groups.

## Where RuleBeat shows more than Azure

Scopes are coarser than Azure's own permissions in two places:

- A role on a single resource shows that resource's whole resource group.
- A narrow role on a subscription shows the whole subscription.

RuleBeat is a compliance tool, and the smallest unit it reports on is a resource group.

## Known gaps

- **PIM for Groups eligibility is not visible until it is activated.** Eligibility for a group lives in
  Entra, and the Azure API RuleBeat reads does not show it. A person whose only access is of that kind
  mirrors as empty until they activate it. Give them Manual access, which covers it.
- **A removed Azure role disappears at the next successful refresh.** That comes on top of Azure's own
  propagation delay, so a person can keep a Scope for up to about an hour plus the time Azure takes
  to report the removal. Press **Refresh** beside the person to read it at once. A failed refresh
  keeps the old Scopes.

## The audit log

Adding someone, changing their access, promoting, demoting, confirming a mirror, refreshing by hand,
switching to Manual and changing a Role each write one entry that names the fields changed and none
of their values: never an object id, a tenant id or a Scope.
