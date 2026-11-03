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

Everything is its own choice on a person's page. It is not the same as ticking every management group,
which would miss what is created later.

## A person's page

The users table on the **Access** page lists each person with their Role and a one-line summary of
their access, such as "2 scopes, mirrored". It has a search by name or email, and a long name or email
is cut short with the whole of it shown on hover. Choosing a person opens their page; **Add user**
opens the same page with a **Work email** field. Setting, resetting or removing a password and removing
a user are in the menu at the end of each row.

A person's page has two parts, and **Save** makes whichever changes they add up to:

- **Role**: Viewer, Editor or Admin, set here and nowhere else. The only Admin cannot be made a Viewer
  or Editor until someone else is an Admin, and the page says so.
- **Access**: Everything, Selected Scopes or Mirrored from Azure. An Admin has access to everything,
  so there is nothing to choose. Every Scope a person holds takes their Role.

A person someone added is given nothing until an access choice is made, so **Add user** stays disabled
until there is one. A Viewer or an Editor sees their own access on the Access page, read-only.

## Mirrored and Manual access

An Admin gives each Viewer and Editor their access one of two ways. A person has one or the other,
never both, so a refresh never has to decide which list wins.

### Manual access

The Admin picks Scopes by hand: **Everything**, or **Selected Scopes** on the person's page. Choosing
Selected Scopes needs at least one Scope. Manual access is the only way to give Everything or the
Directory.

Selected Scopes lists what is chosen, each with a remove control, above one tree to tick more in: the
Directory, then each management group with the groups and subscriptions under it, and a subscription's
resource groups once it is opened. Each level opens and closes on its own, and the search finds a
management group, subscription or resource group by name or id, in any casing, keeping each match under
its parents. A Scope held for a management group the
tree no longer has stays in the list, so it can be removed, and a Save that changes nothing sends
nothing.

- **Covered Scopes are shown, not added twice.** Below a ticked Scope, everything it contains shows as
  ticked with "Covered by" that Scope, and cannot be ticked again. Ticking a Scope that contains ones
  already chosen replaces them. Everything covers all, so while it is chosen there is nothing more to
  tick. A management group covers the groups below it, the subscriptions under any of them and those
  subscriptions' resource groups. A subscription covers its resource groups. Only Everything covers
  the Directory.
- **Every Scope takes the person's Role.** The page never sets a Role per Scope. A person who holds
  Scopes at different Roles, given before this page or through the API, is told so, and saving gives
  every Scope the Role chosen.

When an Admin is made a Viewer or an Editor, Everything is chosen until something narrower is, so the
change never takes access away by itself. Choosing Mirrored from Azure shows the Scopes of the Linked
account first, then demotes the person with no Scopes and links the account. The demote comes first
because Mirrored access is never given to an Admin, and it is never done with Everything, so a failure
leaves the person with nothing rather than everything. If linking fails after the demote, the page says
the person was demoted and holds no access, and Save can be tried again.

### Mirrored access

The Admin picks one Role and a **Linked account**: an Azure object id, which may be a different
account from the one the person signs in with. RuleBeat reads that account's Azure role assignments
with its own Reader credential and turns them into Scopes.

- Active assignments and PIM-eligible ones both count, whether held directly or through a group. A
  tenant without Entra ID P2 or Entra ID Governance has no PIM, so only active assignments are read.
- An assignment on a single resource gives that resource's resource group.
- A role at the tenant root management group gives that management group. A mirror never gives
  Everything or the Directory.
- Deny assignments are ignored.
- The Azure role never decides the RuleBeat Role. Azure Contributor means "can change Azure
  resources"; RuleBeat Editor means "can write rules, schedules and suppressions". The Admin chooses the Role.

Choose **Mirrored from Azure** on a person's page, when adding someone or when demoting an Admin (see
Manual access above for the order of steps). Enter the object id, then **Preview** lists the Scopes the
account would give, with the Azure role behind each, and Save stays disabled until the account saved is
the one last previewed. "Use their sign-in account" fills the object id for a person who signed in with
Entra, when sign-in uses the same tenant as the Azure connection. A mirrored person's page shows their
Linked account, its Scopes, the last refresh, **Refresh**, and **Link a different account**.

**When it refreshes.** About once an hour, after the management group tree is read; in the background
each time the person signs in, which never waits for it; and on demand with the **Refresh** button
on a mirrored person's page. Automatic refreshes write no audit entry.

**When a refresh fails.** The last Scopes are kept, a stable reason is recorded (never Azure's own
text), and the Access page says the refresh failed, when, and that the Scopes shown are the last ones
that loaded. The person sees the same on their own access, with the time of the last successful refresh.

**When there are no assignments.** A refresh that succeeds and finds none gives the person no Scope.
They see a message that they have been given no access and to ask an Admin, in place of "No findings
yet", and the Access page says why.

**Editing by hand.** Choosing Everything or Selected Scopes for a mirrored person turns them into
Manual access with the Scopes shown, and the page says so before Save, so the mirror never overwrites
a hand-made change. Changing their Role keeps the mirror on.

For the mirror and the management group tree to see anything, the Reader credential has to be able to
read it. Grant Reader at the tenant root management group: see [Azure permissions](permissions.md#2-grant-reader).

## The management group tree

The **Management groups** card on the Access page shows when RuleBeat last read its copy of the tree,
and **Refresh** reads it again. The tree opens at its top level, and each group opens and closes on its
own to show the groups and subscriptions under it. A search by name or id keeps each match under its
parents. A failed refresh shows its error on the card, with the tree it kept.

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

## The Scope filter is not access

Dashboards, saved views, widgets and the Scans page can be narrowed by a **Scope filter**. It is not
a way to get access, and it only ever narrows.

- It is matched by the same table as Access, in [Where a finding sits](#where-a-finding-sits), so a
  filter and your Access agree about whether a finding is inside a Scope.
- It can only narrow what you hold.
- The picker shows only the Scopes you hold. A pick nested inside another shows "Covered by" and the
  Scope that covers it.
- A pick you hold only in part applies as the part you hold, and the filter says it is "narrowed to
  what you hold".

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
run shared rules, whose rows are filtered to their resource groups. A person whose access does not
include the Directory cannot query Microsoft Graph: the option is switched off on the Query page and
in the new rule picker, with the reason beside it.

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
  propagation delay (Azure can take up to 10 minutes to apply a role change, and longer at a
  management group), so a person can keep a Scope for up to about an hour plus that time. Press **Refresh** beside the person to read it at once. A failed refresh
  keeps the old Scopes.

## The audit log

Adding someone, changing their access, promoting, demoting, confirming a mirror, refreshing by hand,
switching to Manual, changing a Role and removing someone each write one entry that names the fields
changed and none of their values: never an object id, a tenant id or a Scope.
