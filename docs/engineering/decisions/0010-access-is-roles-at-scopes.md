# ADR 0010: Access is roles at scopes, mirrored from Azure or set by hand, and admins are never scoped

Status: accepted, 2026-10-13 (issue #255, map #254).

## Decision

**A person's access is a set of roles, each held at a scope.** The roles are RuleBeat's own
(Viewer, Editor, Admin) and say what someone can do. The scope says where: Everything, the
Directory, a management group, a subscription or a resource group. Every scope is stored as a tenant
id plus its Azure scope path from day one, so an install that later covers more than one tenant
needs no rewrite of existing access. Everything is its own scope, not the tenant root management
group, because findings from Microsoft Graph rules belong to no subscription. A management group scope covers
whatever sits under it now, including subscriptions added after it was granted. Overlapping access
adds up, the higher role winning, as Azure's own does.

**There are no resource-level scopes.** The smallest scope is a resource group. RuleBeat is a
compliance tool and a person who looks after one VM looks at its resource group.

**A finding is seen by whoever's scope contains the place it sits** (issue #259), whatever the
rule's kind. A Resource Graph finding sits at its resource, or at the subscription or management
group a row names; someone scoped to one resource group does not see a finding on the subscription
above it. A Microsoft Graph finding sits in the **Directory**, a scope of its own that carries no
subscription, granted only by hand because Entra directory roles are not visible through ARM. A Log
Analytics finding sits at the workspace it came from, as in Azure's workspace-context access, so
whoever's scope covers the workspace's resource group sees it. A finding RuleBeat cannot place is
seen only under Everything. Graph and Logs findings no longer borrow the first subscription the
credential lists; existing ones are corrected on upgrade, which strands nothing because a
fingerprint does not include the subscription.

**Azure decides where, never what.** An Azure role name never maps to a RuleBeat role: Azure
Contributor means "can change Azure resources", RuleBeat Editor means "can write rules, schedules
and suppressions", and tying them would make someone a RuleBeat editor because they can delete VMs.

**Viewers and Editors get their access one of two ways, never both.**

- *Mirrored*: an Admin picks one role and the linked account to follow, which may differ from the
  account the person signs in with. The scopes come from that account's Azure role assignments,
  read through ARM by RuleBeat's own Reader credential, hourly and on demand.
- *Manual*: an Admin picks scopes by hand, each with its own role.

Editing a mirrored person's scopes by hand, or switching them to manual explicitly, keeps the
current scopes and stops the sync, so the mirror can never overwrite a hand-made change. Switching
back to mirrored replaces the manual list after a confirmation. Changing a mirrored person's role
leaves the mirror on.

**The mirror counts every assignment.** Any role assignment the linked account holds, directly or
through a group, active or PIM-eligible, built-in or custom, gives read on its scope. An assignment
on a single resource gives that resource's resource group. Deny assignments are ignored. A failed
refresh keeps the last successful result and tells admins it is failing; a refresh that succeeds
with no assignments gives no scope, and the person sees nothing with a message saying why.

**An Admin is never scoped.** An Admin holds everything an Editor can do, on Everything, plus
install administration: people and their access, sign-in, the Azure connection, notifications, the
audit log, categories and rule versions. Only Admins grant access. There are no delegated admins per
subscription or management group.

## Considered options

- **Mapping Azure roles to RuleBeat roles per scope.** Rejected for the reason above, and because it
  would leave no way to make an Azure Reader a RuleBeat Editor.
- **Counting only roles that grant `*/read`, and only active assignments.** That matches what Azure
  itself shows more closely, but shows nothing for a person whose role is narrow or not yet
  activated. Reader access is not privileged, so an eligible assignment counts, and the broader
  grant is accepted for a rule anyone can state in one sentence.
- **Scoped admins who can grant roles on their own scope.** Rejected: an admin who manages users or
  the Azure connection can widen their own scope, so a scoped admin is restricted in appearance
  only.
- **Mixing mirrored and manual scopes on one person.** Rejected: every refresh would have to decide
  which of the two wins, and the answer would surprise someone.

## Consequences

- RuleBeat shows more than Azure does in two places: a role on one resource shows its whole resource
  group, and a narrow role on a subscription shows all of it.
- Eligibility for a group through PIM for Groups lives in Entra and is probably invisible to ARM
  until activated (live test T6 in issue #265). A person whose only access is of that kind mirrors
  as empty; a manual assignment covers them.
- `users.role` and `users.scope` give way to role assignments that record their source. Existing
  users keep working through the upgrade, decided separately in issue #258.
