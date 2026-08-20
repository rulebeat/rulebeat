# Roles and permissions

RuleBeat has <!-- count:roles -->three roles: **viewer**, **editor**, and **admin**. Every role is cumulative: editor
can do everything viewer can, and admin can do everything editor can.

| Role | Can do |
|---|---|
| Viewer | Read and export everything. Cannot change anything. |
| Editor | Everything a viewer can, plus author rules, run scans, manage schedules, dashboards, and suppressions. |
| Admin | Everything an editor can, plus categories, users, sign-in configuration, the Azure connection, notifications, and the audit log. |

## Exactly what each role can do

Every API route names the specific action it performs (`rules:write`, `scans:run`, and so on),
never a role rank directly, so this table is the single place the mapping lives:

| Action | Viewer | Editor | Admin |
|---|:---:|:---:|:---:|
| Read everything (findings, rules, dashboards, scans) | ✅ | ✅ | ✅ |
| Author, edit, delete, or test-validate rules | | ✅ | ✅ |
| Run a manual scan | | ✅ | ✅ |
| Create or edit schedules | | ✅ | ✅ |
| Suppress a finding | | ✅ | ✅ |
| Create, edit, or delete dashboards | | ✅ | ✅ |
| Refresh the resource-type schema cache | | ✅ | ✅ |
| Create or edit categories | | | ✅ |
| Manage users and their roles | | | ✅ |
| Read the audit log | | | ✅ |
| Manage the Azure scanning connection | | | ✅ |
| Manage sign-in configuration (local policy, Microsoft Entra ID) | | | ✅ |
| Manage notification channels | | | ✅ |

Every role, including viewer, can change their own password. This sits outside the ladder above:
it's not something one role grants another, it's something every signed-in account can always do
for itself.

## How a role is decided

A role is looked up from the local `users` table on every request that needs one. It is never
carried on the session token, which means a demotion or a removed account takes effect on the
very next request rather than waiting for a token to expire.

## Provisioning and bootstrap

A brand-new install with zero users seeds one local admin account with a generated password,
forced to change it on first sign-in (see [`install.md`](install.md)). From there, an admin can:

- Create additional local accounts from Settings → Users, choosing their role up front.
- Configure Microsoft Entra ID sign-in (see [`configure.md`](configure.md)) so people sign in with
  their work account instead of a local password. An admin can create a user's row by email before
  they've ever signed in; the account binds to their identity on first login.
- Set `RULEBEAT_INITIAL_ADMIN` to name a work email that becomes an admin automatically on first
  Microsoft sign-in. This also doubles as the lockout recovery path if every admin is ever removed:
  set it and restart.

## Audit log

Every mutation, not just the sensitive ones, writes a row to the audit log: who did it, what
action, a human-readable summary, and the names of the fields that changed (never the values, so a
secret or a credential is never written to the log even indirectly). Only admins can read it, from
Settings → Audit log.
